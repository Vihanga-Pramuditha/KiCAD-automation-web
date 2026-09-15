import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const execAsync = util.promisify(exec);
const app = express();
app.use(cors()); 
app.use(express.json());

// Initialize Gemini 
const genAI = new GoogleGenerativeAI("####API_key###");
const model = genAI.getGenerativeModel({ 
  model: "gemini-3.6-flash",
  systemInstruction: "You are an expert PCB designer and AI agent. You have access to a set of KiCad tools. Analyze the user's PCB request and determine the exact sequence of tools needed to build it. Output ONLY a valid JSON array of tool calls. Format: [ { \"toolName\": \"name_of_tool\", \"toolArgs\": { \"arg1\": \"value1\" } } ]"
});

const transport = new StdioClientTransport({
  command: "node", 
  args: ["/home/uservihanga_pramuditha/mechanoid-mcp/KiCAD-MCP-Server/dist/index.js"]
});

const mcpClient = new Client(
  { name: "mechanoid-web-client", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// AI ROUTE: This is the brain!
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log(`🧠 AI Brain received prompt: "${prompt}"`);

    // 1. Fetching available tools dynamically from KiCad MCP
    const mcpTools = await mcpClient.listTools();

    // 1.5 Injecting custom Node.js tool into the AI's list
    mcpTools.tools.push({
      name: "compile_python_script",
      description: "Executes a Python script locally. Use this to write a script that generates a basic .kicad_pcb file with components placed, bypassing the need to write raw S-expressions manually.",
      inputSchema: {
        type: "object",
        properties: {
          scriptCode: { type: "string", description: "The raw Python code to execute. The script must write its output to a file named 'generated_board.kicad_pcb'." }
        },
        required: ["scriptCode"]
      }
    });

    // 2. Building the prompt for Gemini
    const aiPrompt = `
      User Request: ${prompt}
      
      You are an expert PCB designer agent. 
      Step 1: Use 'compile_python_script' to write a script that generates a valid 'generated_board.kicad_pcb' file containing the requested components.
      Step 2: Use the 'autoroute' tool on 'generated_board.kicad_pcb' to connect the traces.
      
      Available Tools:
      ${JSON.stringify(mcpTools.tools, null, 2)}
      
      Return ONLY a JSON array of tool calls. Format: [ { "toolName": "name", "toolArgs": { ... } } ]
    `;

    // 3. The Self-Healing Agent Loop
    let currentPrompt = aiPrompt;
    let executionResults = [];
    let maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`\n🤔 Gemini is thinking (Attempt ${attempt}/${maxAttempts})...`);
      
      try {
        const result = await model.generateContent(currentPrompt);
        let aiText = result.response.text();
        
        // Cleaning up markdown formatting
        aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
        const toolCalls = JSON.parse(aiText);
        
        console.log("⚡ Executing Tool Sequence:", JSON.stringify(toolCalls, null, 2));
        
        let attemptFailed = false;
        let errorDetails = "";
        executionResults = []; // Reset results for this attempt

        // 4. Execute each tool
        for (const call of toolCalls) {
           if (call.toolName === "compile_python_script") {
             console.log("🐍 Intercepted Python script! Executing locally...");
             await fs.writeFile('ai_builder.py', call.toolArgs.scriptCode);
             
             try {
               const { stdout, stderr } = await execAsync('python3 ai_builder.py');
               executionResults.push({ tool: call.toolName, result: stdout || "Script executed successfully" });
             } catch (scriptError) {
               console.error("❌ Python execution failed!");
               executionResults.push({ tool: call.toolName, error: scriptError.message });
               attemptFailed = true;
               errorDetails = scriptError.message;
               break; // Stopping executing further tools on failure
             }
           } else {
             console.log(`⚙️ Passing ${call.toolName} to KiCad MCP...`);
             try {
               const toolRes = await mcpClient.callTool({
                 name: call.toolName,
                 arguments: call.toolArgs
               });
               executionResults.push({ tool: call.toolName, result: toolRes });
             } catch (mcpError) {
               console.error(`❌ MCP Tool ${call.toolName} failed!`);
               executionResults.push({ tool: call.toolName, error: mcpError.message });
               attemptFailed = true;
               errorDetails = mcpError.message;
               break;
             }
           }
        }

        // Did the attempt succeed?
        if (!attemptFailed) {
          console.log("✅ All tools executed successfully!");
          break; // Break out of the retry loop
        } else {
          console.log("♻️ Feeding error back to Gemini for correction...");
          // Appending the exact error to the prompt for the next loop iteration
          currentPrompt += `\n\nYour previous attempt failed with this error:\n${errorDetails}\n\nPlease analyze the error, fix your code/arguments, and output a corrected JSON tool sequence.`;
        }

      } catch (loopError) {
        console.error("❌ Error parsing AI response:", loopError.message);
        currentPrompt += `\n\nFailed to parse your response as JSON. Error: ${loopError.message}. Ensure you output ONLY a raw JSON array.`;
      }
    }

    // 5. Looking for the generated files to send back
    let schContent = "; AI did not generate a .kicad_sch file.";
    let pcbContent = "; AI did not generate a .kicad_pcb file.";
    let dirFiles = [];

    try {
      // Scanning the directory where the Node server is running
      dirFiles = await fs.readdir(process.cwd());
    } catch (fileError) {
      console.error("Error reading directory:", fileError);
    }

    // Safely searching the array now that it is guaranteed to exist
    const schFile = dirFiles.find(f => f.endsWith('.kicad_sch'));
    const pcbFile = dirFiles.find(f => f === 'generated_board.kicad_pcb');

    try {
      if (schFile) {
        schContent = await fs.readFile(schFile, 'utf8');
      }
      if (pcbFile) {
        pcbContent = await fs.readFile(pcbFile, 'utf8');
      }
    } catch (readError) {
      console.error("Error reading files:", readError);
    }

    // Returning the tool results AND the file contents to the frontend
    res.json({ 
      success: true, 
      results: executionResults,
      files: {
        sch: schContent,
        pcb: pcbContent
      }
    });

  } catch (error) {
    console.error("AI Generation failed:", error);
    res.status(500).json({ error: error.message });
  }
});

async function startBridge() {
  try {
    console.log("Starting MCP KiCad server...");
    await mcpClient.connect(transport);
    console.log("✅ Successfully connected to KiCad MCP Server!");
    
    app.listen(3000, () => {
      console.log("✅ API Bridge listening on http://localhost:3000");
    });
  } catch (error) {
    console.error("Failed to connect:", error);
  }
}

startBridge();

import {Client} from './candidate/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from './candidate/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const browser = process.argv[2] === 'browser';
const transport=new StdioClientTransport({command:browser?process.env.HOME+'/bin/agentbox-browser':process.env.HOME+'/.bun/bin/bun',args:browser?['mcp','--host','auto']:['run',process.argv[2]==='live'?process.env.HOME+'/omg/src/cli.ts':process.env.HOME+'/.cache/agent-tmp/threads-removal-20261002/candidate/src/cli.ts','mcp'],stderr:'pipe'});
const client=new Client({name:'threads-removal-verification',version:'1.0.0'});
try {await client.connect(transport);const {tools}=await client.listTools();console.log(JSON.stringify(browser?tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})):tools.map(t=>t.name)));} finally {await client.close();}

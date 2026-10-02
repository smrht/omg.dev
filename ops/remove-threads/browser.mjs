import {Client} from './candidate/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from './candidate/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
const transport=new StdioClientTransport({command:process.env.HOME+'/bin/agentbox-browser',args:['mcp','--host','auto'],stderr:'pipe'});
const client=new Client({name:'threads-removal-browser-qa',version:'1'});await client.connect(transport);
console.log('BROWSER_MCP_READY');
try {for await (const line of createInterface({input:process.stdin})) {
 const command=JSON.parse(line);if(command.exit)break;
 const result=await client.callTool(command);
 for(const item of result.content??[]) {if(item.type==='image'){const p=new URL('./qa-'+Date.now()+'.png',import.meta.url);fs.writeFileSync(p,Buffer.from(item.data,'base64'));console.log('SCREENSHOT '+p.pathname);} else if(item.type==='text')console.log(item.text);}
 console.log('CALL_DONE');
}}finally {await client.close();}

/** Read-only real 0.159 adapter proof against the staged candidate, no user chat. */
import { CodexAppServerThread } from './candidate/src/agents/backends/codex-app-server-session.ts';
import { codexAppServerTrustedArgv, CodexAppServerClient, initializeAppServer, spawnCodexAppServerTransport } from './candidate/src/codex-daybreak.ts';
const w='/home/agent/.cache/agent-tmp/omg-daybreak-sessions';
const bin='/home/agent/.local/lib/codex-0159/node_modules/.bin/codex';
const argv=codexAppServerTrustedArgv(bin);
const fixture=`${w}/protocol-fixture.txt`, nonce=`PROTO-${crypto.randomUUID()}`;
await Bun.write(fixture,nonce);
let id:string|null=null;
async function turn(program:'daybreakBlue'|'standard',prompt:string,tools:boolean){
 const adapter=new CodexAppServerThread({argv,cwd:w,model:'gpt-6-sol',effort:'low',cyberAccessProgram:program,daybreakEnabled:program!=='standard',resumeThreadId:id});
 const ac=new AbortController();const timeout=setTimeout(()=>ac.abort(),100_000);
 try{
  const {events}=await adapter.runStreamed(prompt,{signal:ac.signal});let text='',commands=0,completed=false;
  for await(const e of events){
   if(e.type==='item.completed' && e.item.type==='command_execution'){commands++;if(e.item.exit_code!==0)throw Error('command failed');}
   if(e.type==='item.completed' && e.item.type==='agent_message')text+=e.item.text;
   if(e.type==='turn.completed')completed=true;
   if(e.type==='error' || e.type==='turn.failed')throw Error('message' in e?e.message:e.error.message);
  }
  if(!completed || !text.includes(nonce) || (tools && commands<1))throw Error(`proof failed completed=${completed} commands=${commands} nonceMatched=${text.includes(nonce)}`);
  if(id && id!==adapter.id)throw Error('native thread changed');id=adapter.id;
  console.log(JSON.stringify({programRequested:program,completed,commands,history:true,reroute:adapter.lastReroute}));
 }finally{clearTimeout(timeout);await adapter.close();}
}
try{
 await turn('daybreakBlue',`Only read ${fixture} using a shell command. Reply only its contents. Remember it for the next turn. No edits, no other files or agents.`,true);
 await turn('standard','What was the content from the previous turn? No tools, reply only the same content.',false);
 console.log('LIVE_ADAPTER_BLUE_TOOLS_OFF_SAME_THREAD_OK');
}finally{
 if(id){const client=new CodexAppServerClient(spawnCodexAppServerTransport({argv}));try{await initializeAppServer(client);await client.request('thread/archive',{threadId:id},10_000);}finally{await client.close();}}
 const {unlink}=await import('node:fs/promises');await unlink(fixture).catch(()=>{});
}

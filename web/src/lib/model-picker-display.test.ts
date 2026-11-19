import { expect, test } from 'bun:test';
import { pickerAgentLabel, pickerModelDisplay, pickerThinkingLabel } from './model-picker-display';
test('separates routing provider from model without changing model identity',()=>{
 expect(pickerModelDisplay('zai-coding-plan/glm-5.3-flash')).toEqual({label:'GLM 5.3 Flash',provider:'Z.ai'});
 expect(pickerModelDisplay('openai/gpt-5.5')).toEqual({label:'GPT-5.5',provider:'OpenAI'});
 expect(pickerModelDisplay('omg/z-ai/glm-5.3-flash').label).toBe('GLM 5.3 Flash');
 expect(pickerModelDisplay('unknown/foo/bar')).toEqual({label:'foo/bar',provider:'unknown'});
 expect(pickerModelDisplay('gemini-4-neon')).toEqual({label:'Gemini 4 Neon',provider:undefined});
 expect(pickerModelDisplay('gemini-pro-orchestrator-neon')).toEqual({label:'Gemini Pro Orchestrator · Neon',provider:undefined});
 expect(pickerModelDisplay('gemini-3.8-flash')).toEqual({label:'Gemini 3.8 Flash',provider:undefined});
 expect(pickerModelDisplay('gpt-oss-120b-medium')).toEqual({label:'GPT-OSS 120B Medium',provider:undefined});
 expect(pickerModelDisplay('opencode/nemotron-3.5-lightning-free')).toEqual({label:'Nemotron 3.5 Lightning',provider:'Gratis'});
 expect(pickerModelDisplay('fusion:astra-6-2+sonnet-5-5-med')).toEqual({label:'Astra 6.2 + Sonnet 5.5',provider:'Fusion'});
 expect(pickerAgentLabel('antigravity')).toBe('Antigravity');
 expect(pickerAgentLabel('opencode')).toBe('OpenCode');
 expect(pickerAgentLabel('Claude · Auto', false)).toBe('Claude');
 expect(pickerAgentLabel('Claude · Auto', true)).toBe('Claude · Auto');
 expect(pickerThinkingLabel('High')).toBe('Hoog');
});

import { expect, test } from 'bun:test';
import { pickerModelDisplay, pickerThinkingLabel } from './model-picker-display';
test('separates routing provider from model without changing model identity',()=>{
 expect(pickerModelDisplay('zai-coding-plan/glm-5.3-flash')).toEqual({label:'GLM 5.3 Flash',provider:'Z.ai'});
 expect(pickerModelDisplay('openai/gpt-5.5')).toEqual({label:'GPT-5.5',provider:'OpenAI'});
 expect(pickerModelDisplay('omg/z-ai/glm-5.3-flash').label).toBe('GLM 5.3 Flash');
 expect(pickerModelDisplay('unknown/foo/bar')).toEqual({label:'foo/bar',provider:'unknown'});
 expect(pickerThinkingLabel('High')).toBe('Hoog');
});

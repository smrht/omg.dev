import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mount, type Mounted } from '../test-support/render';
const { useModelFavorites } = await import('./use-model-favorites');
const { modelFavoritesStorageKey } = await import('./model-favorites');
let ui: Mounted;
const models=['m1','m2','m3'];
function Consumer({agent='favorite-test',name='one'}:{agent?:string;name?:string}) {
 const {favorites,toggle}=useModelFavorites(agent,models,'m1');
 return <div data-consumer={name}><span>{favorites.join(',')}</span><button onClick={()=>toggle('m2')}>Toggle</button><button onClick={()=>toggle('m1')}>Seed</button></div>;
}
beforeEach(()=>{ui=mount();window.localStorage.removeItem(modelFavoritesStorageKey('favorite-test'));window.localStorage.removeItem(modelFavoritesStorageKey('favorite-other'));});
afterEach(()=>ui.cleanup());
test('multiple mounted pickers synchronize and a remount preserves favorites',()=>{
 ui.render(<><Consumer/><Consumer name="two"/><Consumer agent="favorite-other" name="other"/></>);
 ui.flush(()=>{(ui.query('[data-consumer=one] button') as HTMLButtonElement).click()});
 expect(ui.query('[data-consumer=two] span')?.textContent).toBe('m2,m1');
 expect(ui.query('[data-consumer=other] span')?.textContent).toBe('m1');
 ui.remount();ui.render(<Consumer/>);
 expect(ui.query('span')?.textContent).toBe('m2,m1');
});
test('explicit empty list stays empty when selected model is unchanged',()=>{
 window.localStorage.setItem(modelFavoritesStorageKey('favorite-test'),'[]');ui.render(<Consumer/>);
 expect(ui.query('span')?.textContent).toBe('');
});
test('external storage updates are reflected without selecting a different model',()=>{
 ui.render(<Consumer/>);
 ui.flush(()=>{window.localStorage.setItem(modelFavoritesStorageKey('favorite-test'),'["m3","missing"]');window.dispatchEvent(new Event('storage'));});
 expect(ui.query('span')?.textContent).toBe('m3');
 expect(window.localStorage.getItem(modelFavoritesStorageKey('favorite-test'))).toContain('missing');
});

test('blocked browser storage still supports synchronized in-memory favorites',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(window,'localStorage');
 Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new Error('blocked')}});
 try {
  ui.render(<><Consumer agent="favorite-blocked"/><Consumer agent="favorite-blocked" name="two"/></>);
  ui.flush(()=>{(ui.query('[data-consumer=one] button') as HTMLButtonElement).click()});
  expect(ui.query('[data-consumer=two] span')?.textContent).toBe('m2,m1');
 } finally {
  if(descriptor)Object.defineProperty(window,'localStorage',descriptor);
  else delete (window as unknown as {localStorage?:Storage}).localStorage;
 }
});

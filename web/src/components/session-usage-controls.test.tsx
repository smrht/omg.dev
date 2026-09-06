import { afterEach, expect, test } from 'bun:test';
import { mount, type Mounted } from '../test-support/render';
const { SessionUsageControls } = await import('./session-usage-controls');
let ui: Mounted;
afterEach(() => ui?.cleanup());
const row = { key: 'test', sessionId: 'abc', title: 'Mijn taak', live: true };
const plan = { key: 'test', sessionId: 'abc', title: 'Mijn taak', live: true, busy: true, blocked: null, targets: [{ pid: 10, startTicks: 1, label: 'agent', bytes: 1024, reason: null }] };
function button(text: string) { return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement; }
test('opening preview and cancelling never confirms; explicit confirm reports result', async () => {
  ui = mount(); const calls: string[] = []; let result = '';
  const request = async <T,>(path: string): Promise<T> => { calls.push(path); return (path.endsWith('preview') ? { plan, token: 'test-token' } : { closed: true, stopped: 1, remaining: 0, releasedBytes: 1048576 }) as T; };
  ui.render(<SessionUsageControls row={row} request={request} onChanged={m => { result = m; }} />);
  expect(ui.query('a')?.getAttribute('href')).toBe('/sessions/abc'); expect(calls).toHaveLength(0);
  await ui.flushAsync(() => button('Sessie afsluiten').click());
  expect(document.body.textContent).toContain('Deze agent werkt nog');
  expect(calls).toHaveLength(1);
  await ui.flushAsync(() => button('Annuleren').click()); expect(calls).toHaveLength(1);
  await ui.flushAsync(() => button('Sessie afsluiten').click());
  await ui.flushAsync(() => button('Bevestigen en stoppen').click());
  expect(calls.filter(p => p.endsWith('confirm'))).toHaveLength(1);
  expect(result).toContain('Sessie gesloten.'); expect(result).toContain('1 MB');
});
test('protected processes prevent confirm and display the reason', async () => {
  ui = mount();
  const request = async <T,>(): Promise<T> => ({ plan: { ...plan, blocked: 'Gedeelde browser beschermd' }, token: 't' }) as T;
  ui.render(<SessionUsageControls row={{ ...row, live: false }} request={request} onChanged={() => {}} />);
  await ui.flushAsync(() => button('Restprocessen stoppen').click());
  expect(button('Bevestigen en stoppen').disabled).toBe(true);
  expect(document.body.textContent).toContain('Gedeelde browser beschermd');
});
test('failed confirm requires a new preview and refreshes the measurement', async () => {
  ui = mount(); let refreshed = false;
  const request = async <T,>(path: string): Promise<T> => { if (path.endsWith('confirm')) throw new Error('Controle verlopen'); return { plan, token: 't' } as T; };
  ui.render(<SessionUsageControls row={row} request={request} onChanged={() => { refreshed = true; }} />);
  await ui.flushAsync(() => button('Sessie afsluiten').click());
  await ui.flushAsync(() => button('Bevestigen en stoppen').click());
  expect(ui.text()).toContain('Controle verlopen'); expect(refreshed).toBe(true);
});

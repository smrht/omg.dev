import { useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription } from './ui/alert-dialog';
import { Button } from './ui/button';
import type { CleanupPlan } from '../../../src/session-cleanup';

type Result = { closed: boolean; stopped: number; remaining: number; releasedBytes: number };
type Row = { key: string; sessionId: string | null; historySessionId?: string; live: boolean; title: string | null };
export function SessionUsageControls({ row, request, onChanged }: {
  row: Row;
  request: <T>(path: string, body: unknown) => Promise<T>;
  onChanged: (message: string) => void;
}) {
  const [preview, setPreview] = useState<{ plan: CleanupPlan; token: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const label = row.live ? 'Sessie afsluiten' : 'Restprocessen stoppen';
  const openId = row.historySessionId ?? row.sessionId;
  async function inspect() {
    setPending(true); setError('');
    try { setPreview(await request('/api/server/session-usage/preview', { key: row.key })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Controle mislukt'); }
    finally { setPending(false); }
  }
  async function confirm() {
    if (!preview || pending) return;
    setPending(true); setError('');
    try {
      const result = await request<Result>('/api/server/session-usage/confirm', { token: preview.token });
      setPreview(null);
      onChanged(`${result.closed ? 'Sessie gesloten. ' : ''}${result.stopped} processen gestopt; ${Math.round(result.releasedBytes / 1048576)} MB toegerekend geheugen vrijgekomen. ${result.remaining} processen over of overgeslagen.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stoppen mislukt');
      setPreview(null); // one-use token: explicitly inspect again
      onChanged('Afsluiten niet bevestigd. De meting is vernieuwd; controleer opnieuw.');
    } finally { setPending(false); }
  }
  return <>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {openId && <a className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2" href={`/sessions/${encodeURIComponent(openId)}`}>Open gesprek</a>}
      <Button variant="outline" className="min-h-11" disabled={pending} onClick={() => void inspect()}>{pending ? 'Controleren…' : label}</Button>
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-destructive break-words">{error}</p>}
    <AlertDialog open={!!preview} onOpenChange={open => { if (!open && !pending) setPreview(null); }}>
      <AlertDialogContent className="flex max-h-[90dvh] flex-col gap-3 overflow-y-auto">
        <AlertDialogTitle>{label}?</AlertDialogTitle>
        <AlertDialogDescription>{row.title ?? preview?.plan.title}. Gesprek en bestanden blijven bewaard. Alleen de hieronder goedgekeurde processen krijgen een stopverzoek.</AlertDialogDescription>
        {preview?.plan.busy && <p role="alert" className="text-sm text-amber-600">Deze agent werkt nog. Bevestigen onderbreekt het lopende werk.</p>}
        {preview?.plan.blocked && <p role="alert" className="text-sm text-destructive">{preview.plan.blocked}</p>}
        <p className="text-sm">{preview?.plan.targets.filter(t => !t.reason).length ?? 0} van {preview?.plan.targets.length ?? 0} processen kunnen stoppen.</p>
        <ul className="min-h-0 max-h-[40dvh] overflow-y-auto divide-y text-sm">
          {preview?.plan.targets.map(t => <li key={t.pid} className="py-2 break-words">
            {t.label} · PID {t.pid} · {Math.round(t.bytes / 1048576)} MB
            <span className="block text-muted-foreground">{t.reason ? `Blijft staan: ${t.reason}` : 'Wordt netjes gestopt'}</span>
          </li>)}
        </ul>
        <p className="text-xs text-muted-foreground">Controle is één minuut geldig. Een proces dat niet stopt blijft staan; geen harde stop.</p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button variant="outline" className="min-h-11" disabled={pending} onClick={() => setPreview(null)}>Annuleren</Button>
          <Button variant="destructive" className="min-h-11" disabled={pending || !!preview?.plan.blocked || !preview?.plan.targets.some(t => !t.reason)} onClick={() => void confirm()}>{pending ? 'Stoppen…' : 'Bevestigen en stoppen'}</Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

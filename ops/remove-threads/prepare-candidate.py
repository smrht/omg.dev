from pathlib import Path
root=Path(__file__).resolve().parent / "candidate"
p=root/"src/omg-isolation-runtime.ts"
s=p.read_text();marker="/**\n * A thread's one-shot chat completion"
assert marker in s
p.write_text(s[:s.index(marker)])

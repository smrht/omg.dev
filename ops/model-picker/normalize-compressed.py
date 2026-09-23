"""Retain installed encodings when a build emits equivalent compressed content."""
import pathlib,json,hashlib,gzip,shutil,subprocess
h=pathlib.Path.home();old=h/'.local/lib/omg-private/current';build=h/'.cache/agent-tmp/omg-model-picker';files=json.loads((old/'manifest.json').read_text())['files'];count=0
for rel,e in files.items():
 p=build/rel
 if not p.is_file() or p.suffix not in ['.gz','.br']:continue
 if hashlib.sha256(p.read_bytes()).hexdigest()==e['custom']:continue
 original=old/'files'/rel;plain=p.with_suffix('');oldplain=original.with_suffix('')
 assert plain.is_file() and oldplain.is_file() and plain.read_bytes()==oldplain.read_bytes(),rel
 if p.suffix=='.gz':assert gzip.decompress(p.read_bytes())==plain.read_bytes() and gzip.decompress(original.read_bytes())==plain.read_bytes(),rel
 else:
  code="const fs=require('fs'),z=require('zlib');const p=process.argv[1],q=process.argv[2];if(!z.brotliDecompressSync(fs.readFileSync(p)).equals(fs.readFileSync(q)))process.exit(1)"
  for compressed in [p,original]:subprocess.run(['node','-e',code,str(compressed),str(plain)],check=True)
 shutil.copy2(original,p);count+=1
print('IDENTICAL_CONTENT_ENCODINGS_RETAINED',count)

#!/usr/bin/env python3
"""One-time read-only legacy source exporter. PostgreSQL runtime never uses SQLite."""
import argparse,json,os,pathlib,sqlite3
p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('output');a=p.parse_args()
source=pathlib.Path(a.source).resolve()
con=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)
con.row_factory=sqlite3.Row
con.execute('BEGIN')
state=json.loads(con.execute('SELECT data FROM app_state WHERE id=1').fetchone()['data'])
names=['sys_user','sys_role','sys_menu','sys_user_role','sys_role_menu','sessions','request_receipts','tickets','metadata','mappings','snapshots','drafts','links','reply_pages','runs']
tables={name:[dict(row) for row in con.execute('SELECT * FROM '+name)] for name in names}
con.rollback();con.close()
fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as out:json.dump({'state':state,'tables':tables},out,ensure_ascii=False)
print('Exported consistent read-only source snapshot. Row counts:',{k:len(v) for k,v in tables.items()})

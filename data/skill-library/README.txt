O*NET 31.0 skill library loader (Hark, 2026-10-19). Source: https://www.onetcenter.org/dl_files/database/db_31_0_text.zip (CC BY 4.0), unzip to ./onet/.
build_onet_library.py -> library.tsv (21,298 rows). load_library.sql is idempotent (ON CONFLICT DO NOTHING); fix the copy path first.
Production already loaded 2026-10-19; do not re-import.

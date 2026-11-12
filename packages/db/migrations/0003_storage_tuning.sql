-- M2 depolama ayari (docs/ilerleme/M2.md, kanit/m2-depolama-olcumu.json). 500 cihaz x 30 metrik x 5 sn icin olculen projeksiyon:
--   0001 ayari (2 gun siksitirmasiz ham + siksitirmasiz agrega): ~207 GB kalici  -> B-5 butcesini (150 GB) ASAR
--   bu ayar (12 saat siksitirmasiz ham + siksitirilmis agrega):  ~40 GB kalici
-- Olculen: ham satir 212 -> 4,2 bayt (51x, karisik sentetik dagilim), 1 dk agrega satiri 171 -> 19,7 bayt (8,7x).
-- Bedel: sikistirilmis chunk'a gec gelen veri (spool bosalmasi) eklenir (B0 spike dogruladi) ama sikistirilmamis eklemeden pahalidir.

SELECT remove_compression_policy('metric_samples');
-- Yalniz YENI chunk'lari etkiler; mevcutlar oldugu gibi kalir. compress_after >= chunk araligi olmalidir.
SELECT set_chunk_time_interval('metric_samples', INTERVAL '6 hours');
SELECT add_compression_policy('metric_samples', compress_after => INTERVAL '12 hours');

-- 1 dk agrega de siksitirilir; yenileme penceresinden (start_offset = 2 gun) SONRA, boylece yenileme siksitirilmis veriye dokunmaz.
ALTER MATERIALIZED VIEW metric_1m SET (timescaledb.compress = true);
SELECT add_compression_policy('metric_1m', compress_after => INTERVAL '3 days');

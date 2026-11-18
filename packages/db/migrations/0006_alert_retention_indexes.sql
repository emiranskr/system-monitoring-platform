-- M6: saklama temizligi ve bildirim hiz siniri sorgulari icin indeksler (veri degistirmez).
-- Hiz siniri: kanal basina son dakikadaki 'sent' sayisi.
CREATE INDEX notifications_rate_idx ON notifications (channel_id, sent_at) WHERE status = 'sent';
-- Temizlik: eski bitmis bildirimler ve cozulmus olaylar.
CREATE INDEX notifications_purge_idx ON notifications (created_at) WHERE status IN ('sent', 'failed');
CREATE INDEX incidents_resolved_idx ON incidents (resolved_at) WHERE resolved_at IS NOT NULL;

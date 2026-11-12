/* Retain imported history, but only selected bank accounts remain visible. */
UPDATE accounts SET archived=CASE WHEN provider_id IN (SELECT value FROM connections,json_each(connections.selected_accounts) WHERE connections.id='simplefin' AND selection_ready=1) THEN 0 ELSE 1 END WHERE source='simplefin' AND EXISTS(SELECT 1 FROM connections WHERE id='simplefin');

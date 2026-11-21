-- This public PKCE client can read a profile; it has no administrative grants.
INSERT INTO app (name, type, "redirectUris", "clientId", secret)
SELECT 'phooey! finance', 'spa', 'https://finance.phooey.foo/cloud/callback',
       'phooey-finance', lower(hex(randomblob(32)))
WHERE NOT EXISTS (SELECT 1 FROM app WHERE "clientId" = 'phooey-finance');

INSERT INTO app_scope ("appId", "scopeId")
SELECT a.id, s.id FROM app a JOIN scope s ON s.name IN ('openid', 'profile')
WHERE a."clientId" = 'phooey-finance' AND a."deletedAt" IS NULL AND s."deletedAt" IS NULL
AND NOT EXISTS (SELECT 1 FROM app_scope g WHERE g."appId" = a.id
  AND g."scopeId" = s.id AND g."deletedAt" IS NULL);

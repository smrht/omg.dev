<!-- MAC-HEAVY-ROUTE:START -->
## Zware taken en browserwerk

Lees voor zwaar werk, browserwerk of coding-offload eerst ~/sites-beheer/docs/agentbox/mac-heavy-policy.md volledig; dat gedateerde beleid vervangt oudere routes.
Mac eerst voor geschikte taken, anders agentbox-run-heavy met alle guards. Nieuwe geschikte browsers via chrome-work auto; bestaande taken blijven op hun host, 9222 blijft voor Google-routines. Geen auth-kopie, veiligheidsbypass of dubbele start bij onbekende jobuitkomst. Providerpins, autorisatie en productieplaatsing blijven aparte grenzen.
Bron-SHA256: be5531ac0ea054579e34c181d842565c444cc3bb949dd9d46e43eb3bf9cce062
<!-- MAC-HEAVY-ROUTE:END -->

## Live uitrollen op de Agentbox (21-11-2026)

Gebruik voor elke live web- of bronwijziging altijd `bash agentbox/tools/deploy-web.sh <release-naam>` (bouwt `web/dist`, maakt release + rollback via `make_release.py` en draait de geharde `cutover.sh` met verplichte pre-flight). Roep nooit handmatig `ln -sfn` of losse `systemctl --user restart omg` aan zonder pre-flight.

# Agentbox update 0.6.143

Status op 29 september 2026: lokaal voorbereid, NIET LIVE. Tailscale SSH vraagt
gebruikersverificatie. Er zijn in deze run geen wijzigingen op de Agentbox gedaan.
De publieke bootstrap meldde nog 0.6.138, 18 sessies en 26 settings.

## Behoud en activatie

Lees vóór staging de actuele private pointer, manifest, configuratie, service-
instellingen, sessies, routines en Computer-processen opnieuw. `deploy.py` verwacht
`06138-agentbox-20260928`; een nieuwere live customization moet eerst in de
bron worden opgenomen. Neem de actuele safety wrapper en pilot checker over,
behoud hun wijzigingen en voeg alleen 0.6.143 toe aan de ondersteunde versies.

Officiële Linux-release SHA256:
`4293b4125c17f74cbca513fcf243c057ae1f5868f9432082cff6faf250250972`.

Volg de eerdere 06138-runbook: releasehash, expliciete source delta, protocol/
client/web-build, stage, guard negative controls en snapshot replay, statecapture,
backup, safe preflight/apply onder een transient unit, adoptie en statevergelijking,
en publieke desktop/mobiel-QA. Bestaande hashed webassets blijven beschikbaar voor
open tabs. `agents`, `data` en `.env` blijven buiten runtimevervanging. Draai
`run-safe.sh` niet vóór deze gates. De drie Linux boot recovery-tests moeten op
de Linux-kandidaat slagen; Mac-tests vervangen die niet.

## Codex 0.159.0

De globale Mac-CLI is ongewijzigd. Een aparte tijdelijke CLI 0.159.0 gaf via dezelfde
ChatGPT-login echte korte antwoorden op Sol 6.1 en Sol 6 met Daybreak Blue. De oude
Mac-CLI 0.157.1 weigerde Sol 6.1; app-server 0.159.0 werkte. Dit is accountbewijs op
de Mac, nog geen bewijs op de Agentbox.

Controleer op de Agentbox eerst de werkelijk gebruikte `LFG_CODEX_PATH`/CLI,
installatiemethode, versie en accountstatus. Bewaar de oude executable en rollback-
route. Installeer 0.159.0 naar een versiepad, zonder auth/config/sessies te vervangen;
wijs alleen de bestaande CLI-route naar de gecontroleerde executable. Verifieer
versie, discovery en een kort antwoord vóór acceptatie. Bewaar discovery/preferences
vóór een gerichte Codex-refresh; andere providers, favorieten en defaults blijven staan.

Npm-package `@openai/codex@0.159.0`, gecontroleerde registry-integrity:
`sha512-nQWxAkzn+Rhr8TgtIhVhSlqvCytrMoqe+P8xoo4xxhCIBnzOfRs6SEmkMJfTPjkU3BYlsplwDOY2dbSp4+514g==`.
De Linux x64 optional dependency is de npm-alias `npm:@openai/codex@0.159.0-linux-x64`:
`sha512-7ks+EeQjX33wfJXbggseyF0CJRFVgzDHA6BzC7mJjFsJKmdAuOFWMFeMeZe8vL/G6xEpL29wOdwR85sK49F0iA==`.

## Nieuwe functies

Zie FEATURE-DESIGN.md voor de bevestigde scope en grenzen. Geen betaalde media-
generatie uitgevoerd. Configured keys, providerlogin, prijzen en live gebruikers-
route moeten op de Agentbox worden gecontroleerd. Neem secrets nooit op in bewijs.

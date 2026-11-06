# Gates: omg.dev 0.6.68 veilige update

OWNS: GATES.md, .unlazy/update-20260913/**

Scope: Update de lokale omg.dev-control-plane naar 0.6.68 zonder configuratie, sessies, bots, automations, artefacten of draaiende agents kwijt te raken.

- [x] G1: Er bestaat een leesbare pre-updateback-up buiten de installatiemap met data, configuratie en service-unit.
  CHECK: bash .unlazy/update-20260913/verify-update.sh backup
  EXPECT: BACKUP_OK
  EVIDENCE: BACKUP_OK; volledige extra backup 2,9 GB en updater-snapshot 20260913T152741Z-v0.6.66-7aa75529 verified.

- [x] G2: De draaiende control-plane rapporteert versie 0.6.68 en de user-service is actief.
  CHECK: bash .unlazy/update-20260913/verify-update.sh runtime
  EXPECT: RUNTIME_OK version=0.6.68
  EVIDENCE: RUNTIME_OK version=0.6.68; /api/install up-to-date; service active+enabled; pilotgate geheel groen.

- [x] G3: Alle pre-update-ID's voor sessies, agents, bots, auto-agents, artefacten en shipped posts bestaan na de update nog.
  CHECK: bash .unlazy/update-20260913/verify-update.sh data
  EXPECT: DATA_OK
  EVIDENCE: DATA_OK; 25/25 sessies, 2/2 agents, 6/6 bots, 53/53 auto-agents, 120/120 artefacten en 50/50 shipped behouden.

- [x] G4: De omg.dev-configuratie en aangepaste systemd-service zijn bytegelijk gebleven en alle vooraf draaiende agentservices draaien nog.
  CHECK: bash .unlazy/update-20260913/verify-update.sh setup
  EXPECT: SETUP_OK
  EVIDENCE: SETUP_OK agents_before=23 agents_after=27; drie configuratie-/servicehashes exact gelijk.

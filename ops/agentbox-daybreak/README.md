# Daybreak in gewone Codex-chats

Deze uitbreiding hoort bij Agentbox 0.6.143. De bestaande korte Threads-route
blijft behouden. Een normale chat bewaart een afzonderlijke programma-keuze;
elke expliciet gekozen beurt verstuurt `turn/start.cyberAccessProgram` via de
Codex app-server. `daybreakEnabled` in threadmetadata is alleen de bewaarde keuze,
geen bewijs dat de provider het programma heeft toegepast.

De eigen accountcatalogus bepaalt welke modellen Blue of Red aanbieden. De
interface verandert geen model of globale standaard. Uit is expliciet Standard.
Tools blijven beschikbaar onder dezelfde bestaande toestemming en procesisolatie.
Oude draaiende harnesses krijgen geen valse nieuwe capability; hun geschiedenis
blijft hervatbaar. Een keuze wordt bij archiveren en hervatten bewaard.

Staging: vergelijk ieder gewijzigd bronbestand met de vorige private snapshot;
controleer onafhankelijke startup-overlays vóór het maken van de nieuwe manifest;
behoud alle oude hashed assets. Nieuwe preservationmanifest mag uitsluitend de
exact bekende vorige hashes als upgrade-baseline toestaan, plus de officiële
upstreamhash. Gebruik `run-safe.sh` onder een begrensde transient service met
software- en online SQLite-backup. Herstel wijzigt alleen software en pointer,
nooit nieuwere gebruikersdata. Geen actieve sessies massaal herstarten.

Acceptatie: protocol-/rendered tests, root/web types, eigen echte tools-canary,
off/on en cold resume met dezelfde native thread, public desktop/mobile UI,
settings/routines/Computer/processen voor/na. Registreer bewijs na live verificatie.

## Live bewijs, 29 september 2026

Broncommit `91b5a7e0` is op agentbox2 actief, nog steeds als OMG 0.6.143.
De service gebruikt Codex 0.159.0 via de bestaande serviceconfig; de globale CLI
en de bestaande isolation-release blijven ongemoeid. Nieuwe preservationrelease:
`06143-daybreak-sessions-20260929`. De vorige release blijft beschikbaar.

- `protocol-live-proof.ts`: een echte command-turn met Blue, daarna Standard
  met dezelfde native thread en herinnerde fixture; eigen child netjes gesloten.
- `live-session-proof.py`: echte normale chat zonder project, command/transcript,
  expliciet Uit met dezelfde geschiedenis, busy-wijziging 409, interrupt en
  stoppen/cold resume met Blue en dezelfde native thread. Ongeldig model/backend
  geeft 400 zonder een sessie te starten.
- `ui-live-proof.py`: openbare desktop- en mobiele bediening via Codex Werk,
  desktop opslaan en opnieuw aangevinkte Blue, beide mobiele controls zonder
  horizontale overflow; Sol 6.1 krijgt geen onbeschikbaar Daybreak-control.
  Deze UI-probe gebruikt alleen de eigen tijdelijke canary en herstelt tijdelijke
  browservoorkeuren. Bewijs staat lokaal onder `~/.cache/omg-daybreak-sessions/`.
- 95 backendtests, 36 UI/componenttests en 46 Linux-tests slagen; root/web
  typechecks en productiebuild slagen. De foutweergave bij een geweigerde save
  en het behouden van de oude keuze zijn in rendered componenttests geverifieerd;
  de echte backendweigering bij een bezige beurt is apart live geproefd.
- Gecontroleerd behouden: 26 settings, 82 routines inclusief 6 quiet-routines,
  20 bestaande sessie-identiteiten en dezelfde 3 Computer-processen. Credentials
  en accountconfiguraties zijn uitsluitend met hashes vergeleken.

De begrensde veilige activatie slaagde op poging 1. Geverifieerde software- en
online SQLite-backup:
`~/.local/state/omg-update-backups/daybreak-sessions/20260929T203333Z-v0.6.143-a836c35e`.
`state.py` controleert bij software-only rollback de bijbehorende oude pointer,
zonder huidige gebruikersdata naar een ouder snapshot terug te draaien.

Bij de normale chatprobe bleek een officiële builder-skill te ontbreken in de
eerder behouden persoonlijke agents-map. `repair-bundled-skill.py` voegt alleen
het ontbrekende bestand toe na een exacte officiële v0.6.143-hashcontrole;
bestaande persoonlijke instructies worden nooit overschreven. De uiteindelijke
preservationmanifest controleert 9215 bestanden, zonder nieuwe wijzigingen.

De accountcatalogus bood tijdens de proef Blue voor onder andere Sol 6 en
GPT 5.5; Sol 6.1 bood alleen Standard. Dit zijn accountmetadata en geaccepteerde
requests. De provider echoot geen werkelijk toegepast cyberprogramma, dus deze
proef bewijst geen afzonderlijke provider-policy. Een oude actieve harness wordt
niet massaal herstart: stoppen en Resume bewaart de geschiedenis en geeft de
nieuwe sessie de programmacapability.

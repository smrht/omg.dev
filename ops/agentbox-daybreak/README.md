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

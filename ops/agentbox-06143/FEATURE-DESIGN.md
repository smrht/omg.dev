# Eigen Threads, modellen en media

Sam heeft deze routes bevestigd: eigen verbonden agent/model in Threads;
ChatGPT/OpenAI, Google Flow en KIE voor media; Sol 6.1 en Daybreak waar het account
die aanbiedt. De update en keuzefuncties zijn live op de Agentbox.
Directe API-media wacht nog op prijsconfiguratie en de KIE-sleutel.

## Threads

Per Thread een opgeslagen agent/model/reasoning-keuze uit de bestaande verbonden
catalogus. De seriële queue bevriest die keuze voor elk bericht. Korte antwoorden
lopen via een begrensde tool-less Claude-, Codex- of OpenCode-adapter op het eigen
verbonden account; geldige taakbeslissingen gebruiken de gewone sessieroute met
het gekozen paar. Geen hosted OMG-inference fallback bij fouten. OpenCode kan
abonnement óf API-facturering gebruiken; de UI zegt daarom eigen verbonden account.

Daybreak is een echte `turn/start.cyberAccessProgram`-aanvraag via de Codex
app-server, geen fictieve CLI-config. Alleen live ontdekte accessprogramma's mogen
worden gekozen. Sol 6.1 bood op de gecontroleerde Mac-accountcatalogus alleen
standard; Sol 6 bood Daybreak Blue. De gewone SDK heeft geen programma-parameter:
een expliciete programmakeuze geldt daarom voor korte Thread-antwoorden. Een taak
waarvoor dat programma niet kan worden doorgegeven krijgt een zichtbare weigering,
geen stille downgrade. De ontdekte Daybreak-modelalias blijft beschikbaar als
normale modelkeuze. Geen defaults automatisch wijzigen. Geen claim over door de
server werkelijk toegepaste beleidsbeperkingen: het protocol meldt die niet.

## Media

Een optionele Media-knop in de bestaande composer en in Threads opent de eigen
kiezer. De huidige composer, uploads, favorieten en overige instellingen blijven
beschikbaar. Elke job kiest zijn provider en model expliciet:

- ChatGPT: browserhandoff, modelkeuze op ChatGPT, daarna resultaat uploaden.
- Google Flow: browserhandoff, modelkeuze op Flow en eigen browsercredits,
  daarna resultaat uploaden. Flow-credits zijn geen Developer API-budget.
- OpenAI API: server-side OPENAI_API_KEY, ondersteunde Images API-modellen;
  afzonderlijke API-facturering, niet het ChatGPT-abonnement.
- KIE: server-side KIE_API_KEY, gedocumenteerde modeladapters voor beeld/video;
  afzonderlijke KIE-credits.

Browserhandoff is geen automatische generatie. API-jobs blijven geblokkeerd zolang
key/prijs/gebruikerskostenbevestiging ontbreken. Prijs is een schatting; het lokale
plafond is geen provider-side garantie. Geen verzonnen nulprijs en geen OMG-fallback.
Betaalde echte media-smoketest vereist een expliciet budget.

Private jobrecords, request-id/fingerprint, annulering en begrensde providerpolling
voorkomen dubbele submits en late resultaatoverschrijvingen. Uploads en provider-
resultaten gebruiken dezelfde echte image/video-validatie en artifactregistratie.
Thread-resultaten worden via de bestaande mediaweergave toegevoegd, zonder model-
inference. Een procescrash precies tussen commit en callback heeft geen bewezen
exactly-once delivery-garantie; die claim wordt niet gemaakt.

Scope is de Agentbox webinterface op desktop en mobiel. De native iOS-app vergt
een eigen apprelease. Eigen Codex-account, Sol 6.1, Daybreak Blue-aanvraag, een echt
Thread-antwoord en handmatige media via upload/artifact/Thread zijn live bewezen.
Betaalde OpenAI/KIE-generatie is niet uitgevoerd.

# Eigen Threads- en mediaroutes — voorstel, nog niet geïmplementeerd

Per Thread een expliciete agent/model/reasoning-keuze uit de bestaande verbonden
catalogus. Sla de keuze op bij de conversation-owner, expose via het protocol en
gebruik dezelfde keuze voor korte antwoorden en taken. Geen verborgen OMG-call
voor routering of antwoorden; een onbereikbaar abonnement geeft een zichtbare fout,
geen taak of andere provider als automatische fallback.

De bestaande korte antwoordroute gebruikt threadDeps.complete in serve.ts met een
vast hosted Sonnet-model. Bestaande echte taken gaan al via de gewone sessieroute.
Upstream143 ondersteunt ook @agent-vermeldingen; de expliciete modelkeuze moet daar
coherent mee samenwerken, zonder één provider/modelpaar aan een andere agent door
te geven. Bescherm bestaande groeps-/reply-context en de seriële threadqueue.

Gebruik de bestaande geïsoleerde backend-infrastructuur; korte chatantwoorden krijgen
geen schrijf-/shelltools. Hergebruik de modelcatalogus en voorkeuren, geen tweede
catalogus. Verifieer authenticatie en daadwerkelijke accountfacturering vóór er
"via abonnement" staat; OpenCode-modellen kunnen ook API-betaald zijn.

Media: eigen opties per job, zichtbaar account/provider en kostenroute. OMG-credits
alleen na een expliciete keuze. Flow-browsercredits zijn geen Developer API-budget.
Een browserhandoff heet geen automatische integratie. Upload/resultaatweergave hoort
bij de primaire route, inclusief fout/annuleerstatus en cleanup.

Open gebruikerskeuze: ChatGPT/OpenAI-beeld + bestaande Google Flow-video, of ook
Grok. Live beschikbaarheid/login niet gemeten omdat Tailscale SSH om verificatie vraagt.
Echte betaalde media-smoketest pas met expliciet budget. Nooit kunstmatig cost=0
invullen om caps te passeren. Native app-pickers vereisen aparte apprelease; scope
is de bestaande Agentbox webinterface op desktop en mobiel.

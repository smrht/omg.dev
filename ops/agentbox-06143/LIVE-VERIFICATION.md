# Agentbox 0.6.143 — live bewijs

29 september 2026. Runtime: 0.6.143; Codex-servicepad: afzonderlijke CLI 0.159.0.
Globale CLI 0.156.0 en bestaande auth/config blijven behouden.

- Veilige update: PASS. Back-up (server-private, inclusief online SQLite-backups,
  releasehash en configuratie):
  `/home/agent/.local/state/omg-update-backups/update-06143/20260929T192348Z-v0.6.138-f17ddc0c`.
- Setupvergelijking: 26 instellingen, 82 routines (zes quiet), 22 sessies op het
  omschakelmoment, drie Computer-processen. Instellingen/configuratie/routines
  gelijk; Computer-PID en starttijd gelijk. Afgeronde sessies zijn alleen
  geaccepteerd wanneer transcript en procescontrole normale beëindiging bewijzen.
- Actuele private pointer: `06143-agentbox-20260929`. Veiligheidspointer:
  `06143-thread-chat-20260929`. Alle startup-transformaties zijn vooraf op de
  kandidaat uitgevoerd/gecontroleerd; daarna bleef de private manifestcontrole groen.
- Eerste poging teruggedraaid: de eerdere onafhankelijke veiligheidslaag kopieerde
  oude runtime/worker-bestanden over de nieuwe Thread-adapter. De manifestgate
  blokkeerde dit. Terugval en behoud zijn gecontroleerd; de tweede poging slaagde
  met een nieuwe veiligheidsrelease waarin alle overige bestaande onderdelen gelijk
  zijn gebleven. De oude private en veiligheidspointers blijven beschikbaar.
- Officiële releasehash, negatieve drift/versiecontroles en verse snapshot-replay
  geslaagd. 139 gerichte Linux-tests geslaagd (inclusief boot recovery, containment,
  media en Daybreak); na de safety-integratie 49 gerichte checks opnieuw geslaagd.
  Lokale nieuwe modelalias-tests: 67 pass; typecheck en productiebuild geslaagd.
- Eigen Agentbox-account: Sol 6.1 exact modelantwoord OK; Sol 6 met Daybreak Blue
  aanvraag OK. Protocol bewijst de aanvraag en het model, niet de toegepaste policy.
- Echte HTTP-route: opgeslagen Thread-keuze → @omg → eigen Codex → OK, zonder taak.
  Tijdelijke QA-thread gearchiveerd. Modelkiezer en conditional Daybreak live bekeken.
- Echte HTTP-media-route: browserjob → bestaande uploadendpoint → gevalideerde PNG
  → bereikbaar artifact → één Thread-bericht. Tijdelijke upload verwijderd;
  minimale job/artifact-testrecords en gearchiveerde QA-thread blijven als bewijs.
- Live Firefox/Selenium: snel dark-mode-menu, vier providers op desktop en mobiel
  (390px), geen horizontale overflow; modelkeuze Sol 6.1 en alleen ondersteund
  Daybreak-programma. Bestaande overzicht/usage-UI blijft aanwezig. Browser gesloten.
- Isolation guard: success. Geen nieuwe failed units; de vijf eerder bestaande
  failed units zijn niet aan deze update toegeschreven. Geheugendruk avg10 was 0.

## Nog niet gereed: directe API-generatie

ChatGPT en Flow openen de eigen browserroute, waar het model gekozen wordt;
het resultaat kan terug worden geüpload. OpenAI-sleutel aanwezig, vijf modelopties.
Prijsinschatting/plafond ontbreken; API-generatie wordt daarom geweigerd. KIE heeft
vijf modelopties (beeld/video), maar nog geen sleutel of prijsconfiguratie.
Geen betaalde media-generatie uitgevoerd; sleutelbron en budget aan Sam gevraagd.
Geen OMG-credits-fallback. Native iOS is niet aangepast.

## Terugval

Kopieer `rollback-runtime.py` naast de hierboven genoemde back-upmanifest en voer
het daar uit. Het script herstelt runtime en beide oude pointers plus de vorige
Codex-route; actuele data/sessierecords worden niet teruggezet. Controleer daarna
private manifest, sessies, settings, routines en Computer zoals in state.py.
De installer run-safe.sh is eenmalig en weigert herhaling na deze activatie.

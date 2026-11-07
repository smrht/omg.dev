"""Bezos (Sam, 07-11-2026): maak van de "Jij: ..."-regel van een agent een beslissing.

Sam is het brein, agents voeren uit. Een agent vraagt een keuze of een richting;
dit bepaalt welke knoppen het Bezos-scherm toont. Bewust streng: wat niet precies
past op de afgesproken vormen ("ja of nee — X", "A of B") wordt geen knop, maar
"Antwoorden" (chat openen). Liever een knop te weinig dan een verkeerd antwoord.

vorm:
  janee  -> knoppen Ja / Nee; "ja" zegt wat ja doet (uit "Bij ja ..." / "Ja betekent ...")
  ab     -> knoppen A / B (met korte omschrijving als de agent die gaf)
  taak   -> Sam moet zelf iets doen: Gedaan (agent gaat verder) / Openen
  open   -> vrij antwoord nodig: Antwoorden (chat openen)
"""
from __future__ import annotations
import html, re

JANEE = r"(?:ja\s*(?:/|of)\s*nee|nee\s*(?:/|of)\s*ja)"


def _schoon(t: str) -> str:
    t = html.unescape(t or "")
    t = re.sub(r"[`*_]|\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", t)
    return re.sub(r"\s+", " ", t).strip()


def _kort(t: str, n: int) -> str:
    t = t.strip().rstrip(".,;:")
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


def _zin(t: str) -> str:
    m = re.match(r"(.+?[.!?])(\s|$)", t)
    return (m.group(1) if m else t).strip()


def _ja_tekst(rest: str) -> str | None:
    m = re.search(r"((?:Bij ja|Ja betekent(?: dat)?|Ja =)[:,]?\s*.+)", rest, re.I)
    if not m:
        return None
    zin = _zin(m.group(1))
    return _kort(zin[0].upper() + zin[1:], 220) if zin else None


def _ab_label(letter: str, jij: str, tekst: str) -> str:
    m = re.search(rf"\b{letter}\s*\(([^)]{{2,40}})\)", jij) or re.search(rf"\b{letter}\s*[=:]\s*(.{{3,}}?)(?=,?\s+(?:en\s+|of\s+)?{chr(ord(letter) + 1)}\s*[=:]|[.;]|$)", jij)
    if not m:
        m = re.search(rf"(?m)^\W{{0,6}}(?:Optie\s+)?{letter}\W{{0,4}}\s*[:).—–-]\s*(.{{3,60}}?)(?:[.:—–]|\s-\s|$)", tekst)
    return _kort(m.group(1).strip(), 160) if m else ""


def _laatste_vraag(tekst: str) -> str | None:
    """Kale "ja of nee": de vraag zelf staat dan meestal net boven de Jij-regel."""
    regels = [r for r in (tekst or "").splitlines() if not re.match(r"^\W*Jij\b", r)]
    staart = _schoon(" ".join(regels[-25:]))
    vragen = re.findall(r"(?:^|(?<=[.!?:]\s))([A-Z\u00c0-\u00dd][^.!?]{8,200}\?)", staart)
    return _kort(vragen[-1], 200) if vragen else None


def beslis(jij: str, tekst: str = "") -> dict:
    r = _beslis(jij, tekst)
    if r.get("vorm") == "janee" and not (r.get("vraag") or r.get("ja") or r.get("eerst")):
        # Eerst een eerdere Jij-regel met "Ja betekent ...", anders de laatste vraag in de tekst.
        for regel in reversed(re.findall(r"(?m)^\W*Jij\b\W*(.+)$", tekst or "")):
            ja = _ja_tekst(_schoon(regel))
            if ja:
                r["ja"] = ja
                return r
        r["vraag"] = _laatste_vraag(tekst)
    return r


def _beslis(jij: str, tekst: str = "") -> dict:
    if jij.count("`") % 2 or re.search(r"[<>{}\\|]|'\s*,|\)\s*$", jij):
        return {"vorm": "open"}  # code, regels of half afgeknipte tekst: geen knoppen
    j = _schoon(jij).rstrip()
    if len(j) < 4 or not re.match(r"[A-Za-zÀ-ÿ€0-9]", j) or j.startswith("…"):
        return {"vorm": "open"}
    t = tekst or ""
    low = j.lower()
    n_janee = len(re.findall(JANEE, low))
    # A of B
    m = re.match(r"(?:kies |kiezen tussen )?A\s*\(([^)]{2,120})\)\s*of\s*B\s*\(([^)]{2,120})\)[.?]?\s*$", j, re.I)
    if m and n_janee == 0:
        return {"vorm": "ab", "vraag": "Kies A of B", "opties": ["A", "B"], "uitleg": [m.group(1), m.group(2)], "toelichting": None}
    m = re.match(r"(?:kies |kiezen tussen )?(?:optie )?A of (?:optie )?B\b(.*)$", j, re.I)
    if m and n_janee == 0:
        uitleg = [_ab_label("A", j, t), _ab_label("B", j, t)]
        rest = m.group(1).lstrip(" .:,—–-")
        return {"vorm": "ab", "vraag": "Kies A of B", "opties": ["A", "B"],
                "uitleg": uitleg if all(uitleg) else None,
                "toelichting": None if all(uitleg) else (_kort(rest, 220) or None)}
    if n_janee == 1 and re.search(r"\b(beide|allebei|alle drie|per (keuze|vraag|punt))\b", low):
        return {"vorm": "open"}  # meerdere vragen in één regel: niet met één knop te beantwoorden
    if n_janee == 1:
        # "ja of nee ...", "zeg ja of nee ..."
        m = re.match(rf"(?:zeg |antwoord |geef )?{JANEE}\b\s*(.*)$", j, re.I)
        if m:
            rest = m.group(1)
            if not rest or rest[0] in ".?:!—–-,":
                los = rest[0] in ":—–-," if rest else False
                rest = rest.lstrip(".?:!—–-, ")
                if rest and not re.match(r"(Bij ja|Ja betekent|Ja =)", rest, re.I):
                    # "ja of nee — X" / "ja of nee. Krijgt X ...?": X is de vraag zelf
                    vraag = _zin(rest)
                    if not (los or vraag.endswith("?")):
                        return {"vorm": "janee", "vraag": None, "ja": _ja_tekst(rest)}
                    if "," in vraag and re.search(r",\s*(en|of)\s", vraag):
                        return {"vorm": "open"}
                    return {"vorm": "janee", "vraag": _kort(vraag[0].upper() + vraag[1:], 200), "ja": _ja_tekst(rest)}
                return {"vorm": "janee", "vraag": None, "ja": _ja_tekst(rest)}
            mo = re.match(r"(op|voor|over)\s+(.+)$", rest, re.I)
            if mo:
                onderwerp = mo.group(2).strip()
                kop = _zin(onderwerp)
                if re.search(r",\s*(en|of)\s|\s(en|of)\s+(ja|niks|vervang|wacht)", kop, re.I):
                    return {"vorm": "open"}
                return {"vorm": "janee", "vraag": _kort(f"Ja of nee {mo.group(1).lower()} {kop}".rstrip(".?"), 200),
                        "ja": _ja_tekst(onderwerp[len(kop):])}
            return {"vorm": "open"}
        # "luister sample A en antwoord ja of nee."
        m = re.match(rf"(.{{3,140}}?),?\s+en (?:antwoord|zeg|geef) (?:dan )?{JANEE}[.?!]?\s*(.*)$", j, re.I)
        if m and not re.search(r"\b(en|of)\b.*\b(en|of)\b", m.group(1)):
            return {"vorm": "janee", "vraag": None, "eerst": _kort(m.group(1)[0].upper() + m.group(1)[1:], 140),
                    "ja": _ja_tekst(m.group(2))}
        return {"vorm": "open"}
    if n_janee > 1:
        return {"vorm": "open"}
    # "mogen we X? Ja betekent ..."
    m = re.match(r"([^?]{5,180}\?)\s+(Bij ja|Ja betekent|Ja =)", j)
    if m:
        return {"vorm": "janee", "vraag": _kort(m.group(1)[0].upper() + m.group(1)[1:], 200), "ja": _ja_tekst(j[len(m.group(1)):])}
    # Vrij antwoord nodig: vraagt informatie, een keuze in woorden of meerdere dingen.
    if "?" in j or re.match(r"(zeg|kies|noem|geef|vertel|laat weten|stuur|vul|plak)\b", low) or re.search(r"\b(of|zeg|antwoord\w*)\b|laat .{0,40}weten", low):
        return {"vorm": "open"}
    if len(j) > 160 or re.search(r"`|<|\.\.\.|…$", j):
        return {"vorm": "open"}
    return {"vorm": "taak", "vraag": _kort(j[0].upper() + j[1:], 200)}


def laatste_jij(text: str) -> tuple[str, str] | None:
    """(korte regel, volle regel) van de laatste "Jij: ..." in een bericht, of None.
    De korte regel (max 240 tekens) is de sleutel van de taak; collect en api delen dit."""
    kort = re.findall(r"Jij:\s*([^\n]{2,240})", text or "")
    vol = re.findall(r"Jij:\s*([^\n]{2,})", text or "")
    if not kort:
        return None
    return kort[-1].strip().rstrip("."), vol[-1].strip()


def sleutel(j: str) -> str:
    import hashlib
    return hashlib.sha1(j.encode()).hexdigest()[:8]

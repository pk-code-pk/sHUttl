"""
Campus gazetteer: a place a calendar event names -> the shuttle stop to alight at.

Calendar events say "Science Center Hall B" or "SEC 1.321", never a stop id or
a coordinate. The shuttle feed has 24 stops, so a hand-written table is both
smaller and more reliable than geocoding: a geocoder does not know that the
right stop for the Kennedy School depends on which way you are travelling, or
that "Pfoho" is a house on the Quad.

Each entry carries an approximate coordinate for the building so the walk from
the stop can be estimated, and an ordered list of stop ids. Several stops are
listed where a place is served by paired stops (northbound/southbound) or sits
between two — the planner tries every listed stop and picks whichever the bus
reaches first, so a rider is never told to stay on to the "wrong" side of a
pair. The first id is the one reported as the destination stop.

Stop ids, as the Ride Systems feed labels them (see rs.get_stops()):
   1 Maxwell Dworkin        2 Radcliff Yard          3 Widener Gate
   4 Harvard Sq (NB)        5 Mass Ave & Garden St   7 Law School
   8 Kennedy School (NB)    9 Stadium (NB)          10 Mather and Dunster
  11 Memorial Hall         12 Quincy Square         13 1 Western Ave
  14 Barry's Corner (SB)   15 Lamont Library        16 Kennedy School (SB)
  17 Harvard Sq (SB)       18 SEC                   19 Stadium (SB)
  20 Leverett House        21 Barry's Corner (NB)   22 Sever Gate
  23 Science Center        25 Winthrop House        28 Radcliffe Quad
"""

import difflib
import re
from typing import Optional

# name -> (lat, lng, [stop ids, preferred first])
PLACES: dict[str, tuple[float, float, list[str]]] = {
    # North of the Yard / science area
    "Science Center": (42.3767, -71.1160, ["23"]),
    "Cabot Science Library": (42.3767, -71.1160, ["23"]),
    "Jefferson Lab": (42.3771, -71.1170, ["23"]),
    "Lyman Lab": (42.3771, -71.1168, ["23"]),
    "Maxwell Dworkin": (42.3789, -71.1167, ["1"]),
    "Pierce Hall": (42.3785, -71.1161, ["1"]),
    "Mallinckrodt": (42.3789, -71.1158, ["1"]),
    "Northwest Building": (42.3796, -71.1152, ["1"]),
    "Northwest Labs": (42.3796, -71.1152, ["1"]),
    "Museum of Natural History": (42.3785, -71.1155, ["1"]),
    "HMNH": (42.3785, -71.1155, ["1"]),
    "Peabody Museum": (42.3783, -71.1150, ["1"]),
    "Divinity School": (42.3786, -71.1137, ["11", "1"]),
    "Andover Hall": (42.3786, -71.1137, ["11", "1"]),
    "William James Hall": (42.3775, -71.1139, ["11"]),
    "Yenching Library": (42.3775, -71.1147, ["11"]),
    # Memorial Hall block
    "Memorial Hall": (42.3763, -71.1146, ["11"]),
    "Sanders Theatre": (42.3763, -71.1146, ["11"]),
    "Annenberg": (42.3763, -71.1146, ["11"]),
    "Lowell Lecture Hall": (42.3762, -71.1152, ["11"]),
    "Gund Hall": (42.3762, -71.1138, ["11"]),
    "GSD": (42.3762, -71.1138, ["11"]),
    "Graduate School of Design": (42.3762, -71.1138, ["11"]),
    # Law School
    "Law School": (42.3782, -71.1198, ["7"]),
    "HLS": (42.3782, -71.1198, ["7"]),
    "Langdell": (42.3782, -71.1198, ["7"]),
    "Wasserstein": (42.3789, -71.1194, ["7"]),
    "WCC": (42.3789, -71.1194, ["7"]),
    "Austin Hall": (42.3778, -71.1195, ["7"]),
    "Hauser Hall": (42.3785, -71.1194, ["7"]),
    "Littauer": (42.3777, -71.1186, ["7"]),
    # Radcliffe Yard / Garden St
    "Radcliffe Yard": (42.3763, -71.1220, ["2"]),
    "Longfellow Hall": (42.3760, -71.1224, ["2"]),
    "Gutman Library": (42.3757, -71.1220, ["2"]),
    "Cambridge Common": (42.3757, -71.1205, ["5"]),
    "Johnston Gate": (42.3748, -71.1185, ["5"]),
    "Massachusetts Hall": (42.3746, -71.1184, ["5"]),
    "Harvard Hall": (42.3746, -71.1180, ["5", "3"]),
    # Harvard Yard
    "Harvard Yard": (42.3744, -71.1172, ["3", "22"]),
    "University Hall": (42.3744, -71.1172, ["3"]),
    "Widener Library": (42.3734, -71.1164, ["3"]),
    "Boylston Hall": (42.3733, -71.1170, ["3"]),
    "Wigglesworth": (42.3729, -71.1172, ["3"]),
    "Sever Hall": (42.3745, -71.1155, ["22"]),
    "Emerson Hall": (42.3739, -71.1152, ["22"]),
    "Robinson Hall": (42.3748, -71.1155, ["22"]),
    "Harvard Art Museums": (42.3742, -71.1142, ["22"]),
    "Fogg Museum": (42.3742, -71.1142, ["22"]),
    "Carpenter Center": (42.3738, -71.1142, ["22"]),
    "Barker Center": (42.3736, -71.1146, ["15", "22"]),
    "Lamont Library": (42.3728, -71.1150, ["15"]),
    "Houghton Library": (42.3730, -71.1156, ["15"]),
    # Square
    "Harvard Square": (42.3732, -71.1190, ["4", "17"]),
    "Smith Campus Center": (42.3729, -71.1185, ["4", "17"]),
    "Holyoke Center": (42.3729, -71.1185, ["4", "17"]),
    # River houses
    "Quincy House": (42.3716, -71.1160, ["12"]),
    "Adams House": (42.3719, -71.1163, ["12"]),
    "Claverly Hall": (42.3720, -71.1163, ["12"]),
    "Lowell House": (42.3719, -71.1172, ["25", "12"]),
    "Winthrop House": (42.3714, -71.1175, ["25"]),
    "Eliot House": (42.3712, -71.1201, ["25", "8"]),
    "Kirkland House": (42.3712, -71.1190, ["25"]),
    "Leverett House": (42.3698, -71.1168, ["20"]),
    "Mather House": (42.3686, -71.1149, ["10"]),
    "Dunster House": (42.3689, -71.1156, ["10"]),
    # Kennedy School
    "Kennedy School": (42.3713, -71.1213, ["8", "16"]),
    "HKS": (42.3713, -71.1213, ["8", "16"]),
    "Harvard Kennedy School": (42.3713, -71.1213, ["8", "16"]),
    "Littauer Center HKS": (42.3713, -71.1213, ["8", "16"]),
    # The Quad
    "Radcliffe Quad": (42.3817, -71.1253, ["28"]),
    "The Quad": (42.3817, -71.1253, ["28"]),
    "Cabot House": (42.3814, -71.1247, ["28"]),
    "Currier House": (42.3818, -71.1263, ["28"]),
    "Pforzheimer House": (42.3822, -71.1248, ["28"]),
    "Pfoho": (42.3822, -71.1248, ["28"]),
    "Hilles": (42.3812, -71.1263, ["28"]),
    # Allston
    "SEC": (42.3633, -71.1256, ["18"]),
    "Science and Engineering Complex": (42.3633, -71.1256, ["18"]),
    "Harvard Innovation Labs": (42.3642, -71.1250, ["18"]),
    "i-lab": (42.3642, -71.1250, ["18"]),
    "Harvard Stadium": (42.3670, -71.1265, ["9", "19"]),
    "Stadium": (42.3670, -71.1265, ["9", "19"]),
    "Athletic Complex": (42.3663, -71.1248, ["9", "19"]),
    "Murr Center": (42.3663, -71.1248, ["9", "19"]),
    "Lavietes Pavilion": (42.3665, -71.1240, ["9", "19"]),
    "Bright-Landry Hockey Center": (42.3660, -71.1245, ["9", "19"]),
    "Harvard Business School": (42.3671, -71.1222, ["9", "19", "13"]),
    "HBS": (42.3671, -71.1222, ["9", "19", "13"]),
    "Baker Library": (42.3671, -71.1222, ["9", "19", "13"]),
    "Spangler Center": (42.3660, -71.1218, ["13", "9"]),
    "Barry's Corner": (42.3640, -71.1278, ["21", "14"]),
    "Barrys Corner": (42.3640, -71.1278, ["21", "14"]),
    "Harvard Ed Portal": (42.3635, -71.1280, ["21", "14"]),
    "1 Western Ave": (42.3640, -71.1208, ["13"]),
    "One Western Ave": (42.3640, -71.1208, ["13"]),
    # The SEAS teaching addresses on Western Ave. my.harvard prints the street
    # address rather than a building name for these ("114 Western Ave 2111"),
    # and without a row of their own they matched "1 Western Ave" — a stop on
    # a different route, a few hundred metres the wrong way. Positions are
    # interpolated along Western Ave between number 1 and the SEC at 150, both
    # of which are surveyed above; each lands within ~100m of the SEC stop,
    # which is the one that serves them.
    "114 Western Ave": (42.3636, -71.1244, ["18"]),
    "125 Western Ave": (42.3635, -71.1246, ["18"]),
    "150 Western Ave": (42.3633, -71.1256, ["18"]),
    "Soldiers Field Park": (42.3652, -71.1226, ["13"]),
}

# Words that carry no location information in an event title. "hall" is here
# deliberately: "Sever Hall 113" and "Sever" must land on the same row, and
# nothing on campus is distinguished by that word alone.
_STOPWORDS = {
    "hall", "room", "rm", "bldg", "building", "the", "of", "at", "and", "in",
    "classroom", "lobby", "floor", "fl", "harvard", "university",
    "library", "house", "center", "centre",
}
# "harvard", "house", "center", "library" are only dropped when the rest of
# the name still says something, so that "Harvard Hall" or "Science Center"
# do not collapse to nothing. Handled in _tokens().
_KEEP_IF_ALONE = {"harvard", "house", "center", "library"}

_SPLIT_RE = re.compile(r"[^a-z0-9']+")


def _tokens(text: str) -> list[str]:
    """Lower-case content words, with room numbers and section letters gone.

    Room designators come in every shape a registrar can invent — "G115",
    "1.321", "Hall B", "Rm 105" — so anything with a digit and any lone letter
    is dropped rather than pattern-matched.

    The exception is a bare number at the very front, which is a street
    address and part of the building's identity: 1, 114 and 150 Western Ave
    are three different buildings several hundred metres apart, served by
    different stops. Dropping it made "114 Western Ave 2111" and
    "1 Western Ave" the same two tokens and so an exact match.
    """
    raw = [t for t in _SPLIT_RE.split(text.lower().replace("'", "")) if t]
    words: list[str] = []
    for i, t in enumerate(raw):
        if t.isdigit():
            if i == 0:
                words.append(t)
            continue
        if any(ch.isdigit() for ch in t) or len(t) <= 1:
            continue
        words.append(t)
    kept = [w for w in words if w not in _STOPWORDS or w in _KEEP_IF_ALONE]
    strict = [w for w in kept if w not in _STOPWORDS]
    return strict or kept


# Gazetteer rows spell some addresses out ("One Western Ave"), so the leading
# word has to be read as the number it is or the mismatch penalty below never
# fires against it.
_NUMBER_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5"}


def _street_number(toks: list[str]) -> Optional[str]:
    if not toks:
        return None
    head = toks[0]
    if head.isdigit():
        return head
    return _NUMBER_WORDS.get(head)


_PLACE_TOKENS: dict[str, list[str]] = {name: _tokens(name) for name in PLACES}


def match_place(query: str) -> Optional[tuple[str, float]]:
    """Best gazetteer row for a free-text query, as (name, confidence).

    Confidence blends how much of the place name the query contains with how
    much of the query the name explains, so "Science Center Hall B" scores
    high against "Science Center" but "Harvard" alone does not pick Harvard
    Hall over Harvard Square with any conviction.
    """
    q = _tokens(query)
    if not q:
        return None
    qset = set(q)
    qnum = _street_number(q)

    best: Optional[tuple[str, float]] = None
    for name, ptoks in _PLACE_TOKENS.items():
        if not ptoks:
            continue
        overlap = len(qset & set(ptoks))
        if overlap == 0:
            continue
        coverage = overlap / len(ptoks)
        precision = overlap / len(qset)
        # Coverage is what tells us the query really names this place; precision
        # only breaks ties between places the query covers equally well.
        score = 0.7 * coverage + 0.3 * precision
        # Two street addresses on the same road that disagree about the number
        # are not the same building, however well the rest of the name matches.
        # Drop them below the acceptance floor so the caller falls through to
        # the stop names, or reports an honest miss, instead of walking the
        # rider to the wrong end of the street with full confidence.
        pnum = _street_number(ptoks)
        if qnum and pnum and qnum != pnum:
            score *= 0.35
        if best is None or score > best[1]:
            best = (name, round(score, 3))

    if best is not None and best[1] >= 0.5:
        return best

    # No token in common — likely a typo ("Maxwel Dworkin"). Compare the whole
    # normalised string instead; the cutoff is high because a wrong building is
    # worse than an honest miss that falls through to stop names.
    joined = " ".join(q)
    candidates = {" ".join(t): n for n, t in _PLACE_TOKENS.items() if t}
    close = difflib.get_close_matches(joined, list(candidates), n=1, cutoff=0.75)
    if close:
        ratio = difflib.SequenceMatcher(None, joined, close[0]).ratio()
        return candidates[close[0]], round(0.6 * ratio, 3)

    # A weak partial hit ("ave" alone) is worse than letting the caller try the
    # stop names, which is where "Mass Ave & Garden St" actually lives.
    return None


def match_stop_name(query: str, stop_names: list[str]) -> Optional[tuple[str, float]]:
    """Fuzzy fallback straight onto stop names, for queries the gazetteer misses.

    Runs on tokens rather than the raw string so "Kennedy School (Northbound)"
    can match "kennedy" without the parenthetical dragging the ratio down.
    """
    q = " ".join(_tokens(query))
    if not q:
        return None
    normalised = {" ".join(_tokens(n)) or n.lower(): n for n in stop_names}
    for key, name in normalised.items():
        if key and (key in q or q in key):
            return name, 0.6
    close = difflib.get_close_matches(q, list(normalised), n=1, cutoff=0.5)
    if not close:
        return None
    ratio = difflib.SequenceMatcher(None, q, close[0]).ratio()
    return normalised[close[0]], round(0.5 * ratio, 3)

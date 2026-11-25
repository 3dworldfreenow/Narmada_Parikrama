#!/usr/bin/env python3
"""Bike / four-wheeler parikrama route, from the list by Acharya Shri Anildas Yogiraj,
Shri Bhakti Ashram, Gomukh Ghat, Omkareshwar. Writes data/vehicle_route_src.json
(English names, km from the previous stop, notes). Map positions are added by
tools/geocode_vehicle.py (GitHub Action) into data/vehicle_route.json."""
import json, os

# (km from previous stop, English name, Hindi name as written, note, search name/state hint)
PART1 = [  # Omkareshwar → Vimleshwar (sea), south bank, going west
 (0, "Omkareshwar", "ओंकारेश्वर", "", "MP"),
 (22, "Toksar", "टोंकसर", "", "MP"), (15, "Raverkhedi", "रावेरखेड़ी", "Peshwa Bajirao's samadhi", "MP"),
 (22, "Bhatyan Buzurg", "भट्याण बुजुर्ग", "", "MP"), (45, "Khaltaka", "खलटांका", "", "MP"), (11, "Thikri", "ठीकरी", "", "MP"),
 (33, "Mohipura", "मोहीपुरा", "", "MP"), (6, "Datwada", "दतवाड़ा", "", "MP"), (6, "Chhota Barda", "छोटा बड़दा", "", "MP"),
 (5, "Dahi Bayda", "दही बयड़ा", "", "MP"), (10, "Barwani", "बड़वानी", "", "MP"), (23, "Pati", "पाटी", "", "MP"),
 (29, "Khetia", "खेतिया", "", "MP"), (27, "Brahmanpuri", "ब्राम्हणपुर", "", "MH"), (38, "Vagvadev", "वाग्वदेव", "", "MH"),
 (17, "Dhadgaon Phata", "धड़गांव फाटा", "Turn-off for Dhadgaon", "MH"), (27, "Molgi", "मोलगी", "", "MH"),
 (28, "Dumkhal", "डूमखल", "", "GJ"), (32, "Dediapada", "डेडियापाड़ा", "The Shoolpaneshwar forest stretch ends after this", "GJ"),
 (45, "Rajpipla", "राजपीपला", "", "GJ"), (15, "Nani–Moti Panoti", "नानी मोटी पनोती", "", "GJ"), (6, "Kothara", "कोठारा", "", "GJ"),
 (5, "Poicha", "पोइचा", "", "GJ"), (30, "Sisodara", "सिसोदरा", "", "GJ"), (5, "Ori", "ओरी", "", "GJ"), (8, "Kandroj", "कांदरोज", "", "GJ"),
 (10, "Asha", "अशा", "", "GJ"), (30, "Jhagadia", "झगड़िया", "", "GJ"), (24, "Ankleshwar", "अंकलेश्वर", "", "GJ"),
 (7, "Ramkund", "रामकुंड", "", "GJ"), (10, "Balbala Kund", "बलबला कुंड", "", "GJ"), (12, "Hansot", "हांसोट", "On the Dandi March route", "GJ"),
 (10, "Hanuman Tekri", "हनुमान टेकरी", "", "GJ"), (10, "Vimleshwar", "वमलेश्वर", "Sea coast. Boat to Mithitalai (see note)", "GJ"),
]
PART2 = [  # Mithitalai → Amarkantak, north bank, going east
 (0, "Mithitalai", "मीठीतलाई", "Boat landing from Vimleshwar", "GJ"),
 (25, "Bhadbhuteshwar", "भाड़भूतेश्वर", "", "GJ"), (10, "Bharuch", "भरूच", "", "GJ"), (16, "Shuklatirth", "शुक्लतीर्थ", "Kabirvad", "GJ"),
 (32, "Moti Koral", "मोटी कोरल", "Punit Ashram", "GJ"), (7, "Nareshwar", "नारेश्वर", "Rang Avadhoot Ashram", "GJ"),
 (14, "Diver", "दिवेर", "", "GJ"), (13, "Malsar", "मालसर", "", "GJ"), (8, "Kanjetha", "कंजेठा", "", "GJ"), (6, "Ambali", "अम्बाली", "", "GJ"),
 (12, "Badrikashram", "बद्रिकाश्रम", "", "GJ"), (2, "Gangnath Mahadev", "गंगनाथ महादेव", "", "GJ"), (2, "Chanod", "चाणोद", "", "GJ"),
 (5, "Karnali", "कुबेर भंडारी करनाली", "Kuber Bhandari temple", "GJ"), (21, "Tilakwada", "तिलकवाड़ा", "", "GJ"),
 (16, "Garudeshwar", "गरूड़ेश्वर", "Vasudevanand Saraswati Swami Ashram", "GJ"),
 (11, "Statue of Unity", "स्टेच्यू ऑफ यूनिटी", "Valley of Flowers, Sardar Sarovar Dam", "GJ"),
 (60, "Kawant", "कवाँट", "", "GJ"), (15, "Hanfeshwar", "हांफेश्वर", "The Shoolpaneshwar forest stretch begins again after this", "GJ"),
 (29, "Bakhatgarh", "बखतगढ़", "", "MP"), (10, "Chhaktala", "छकतला", "", "MP"), (38, "Kawada", "कवड़ा", "Hanuman temple", "MP"),
 (13, "Dahi", "डही", "", "MP"), (24, "Meghnad Ghat", "मेघनाद घाट", "The Shoolpaneshwar forest stretch ends", "MP"),
 (15, "Susari", "सुसारी", "", "MP"), (11, "Nisarpur", "निसरपुर", "", "MP"), (16, "Bodhwada", "बोधवाड़ा", "", "MP"),
 (17, "Semalda", "सेमल्दा", "", "MP"), (6, "Badgaon Khedi", "बड़गांव खेड़ी", "", "MP"), (7, "Ajanda", "अजन्दा", "", "MP"),
 (7, "Bakaner", "बाकानेर", "", "MP"), (24, "Dharampuri", "धरमपुरी", "", "MP"),
 (27, "Mandu (Rewa Kund)", "मांडू रेवाकुंड", "Jahaz Mahal, Roopmati Pavilion", "MP"), (26, "Dhamnod", "धामनोद", "", "MP"),
 (13, "Maheshwar", "महेश्वर", "", "MP"), (7, "Mandleshwar", "मंडलेश्वर", "", "MP"), (41, "Barwaha", "बड़वाह", "", "MP"),
 (6, "Khedighat", "खेड़ीघाट", "", "MP"), (2, "Charukeshwar", "चारूकेश्वर", "Confluence with the Choral river", "MP"),
 (30, "Katkut", "काटकूट", "", "MP"), (24, "Udaynagar", "उदयनगर", "", "MP"),
 (20, "Sitavan, Pipri", "सीतावन, पीपरी", "Sita–Valmiki Ashram", "MP"), (10, "Ratanpur", "रतनपुर", "Forest road", "MP"),
 (8, "Jayanti Mata Falls", "जयंतिमाता प्रपात", "Lakadkot forest", "MP"), (17, "Pamakhedi", "पामाखेड़ी", "", "MP"),
 (15, "Dharmeshwar", "धर्मेश्वर", "", "MP"), (19, "Tipras", "टिपरास", "", "MP"), (12, "Pipalkota", "पीपलकोटा", "", "MP"),
 (20, "Dawta", "डावटा", "Bagdi river confluence", "MP"), (11, "Nemawar", "नेमावर", "Narmada Nabhi Tirth – navel of the Narmada", "MP"),
 (36, "Chhipaner", "छीपानेर", "", "MP"), (54, "Salkanpur", "सलकनपुर", "", "MP"), (27, "Budhni", "बुधनी", "", "MP"),
 (15, "Bandrabhan", "बांदराभान", "", "MP"), (22, "Jait", "जैत", "Village of a former Chief Minister", "MP"),
 (8, "Nandner", "नंदनेर", "", "MP"), (3, "Dehri", "डेहरी", "", "MP"), (10, "Baktara", "बक्तारा", "", "MP"),
 (18, "Badi", "बाड़ी", "", "MP"), (20, "Bareli", "बरेली", "", "MP"), (22, "Satrawan", "सतरावन", "Tyagi Ashram, Muwar", "MP"),
 (20, "Aliganj", "अलीगंज", "", "MP"), (16, "Ketoghan", "केतोघन", "", "MP"), (24, "Udaipura", "उदयपुरा", "", "MP"),
 (12, "Kelkachh", "केलकच्छ", "", "MP"), (19, "Deori", "देवरी", "", "MP"), (21, "Tendukheda", "तेंदुखेड़ा", "", "MP"),
 (20, "Lolri", "लोलरी", "", "MP"), (10, "Barman", "बरमान", "", "MP"), (10, "Gurshi", "गुरशी", "Chhota Dhuandhar falls", "MP"),
 (31, "Bildha", "बिल्धा", "", "MP"), (17, "Vikramnagar", "विक्रमनगर", "", "MP"), (14, "Belkheda", "बेलखेड़ा", "", "MP"),
 (25, "Shahpura (Jabalpur)", "शाहपुरा", "", "MP"), (15, "Saraswati Ghat", "सरस्वतीघाट या रविदास घाट", "Also called Ravidas Ghat", "MP"),
 (5, "Kachnar City", "कचनारसिटी", "", "MP"), (3, "Bhadpura", "भाड़पुरा", "Tripura Sundari, Pitambara Peeth", "MP"),
 (17, "Lamheta Ghat", "लम्हेटाघाट", "Gwarighat, Ghughra falls", "MP"), (14, "Jabalpur", "जबलपुर", "", "MP"),
 (21, "Barela", "बारेला", "", "MP"), (7, "Dobhi", "डोभी", "", "MP"), (13, "Bijadandi", "बीजाडांडी", "", "MP"),
 (28, "Kumha", "कुम्हा", "", "MP"), (5, "Chirai", "चिरई", "", "MP"), (16, "Barrasagar", "बर्रासागर", "", "MP"),
 (15, "Mandla", "मंडला", "", "MP"), (3, "Badi Khairi", "बड़ी खैरी", "", "MP"), (3, "Amnala", "अमनाला", "", "MP"),
 (9, "Kindri", "किन्दरी", "", "MP"), (12, "Paundi Linga", "पौंडीलिंगा", "", "MP"),
 (56, "Niwas", "निवास", "Via Chhota Umaria", "MP"), (5, "Bijhouli Fossil Park", "बिझौली फॉजिल्स पार्क", "", "MP"),
 (32, "Shahpura (Dindori)", "शाहपुरा", "", "MP"), (34, "Mali", "माली", "", "MP"), (29, "Umaria", "उमरिया", "", "MP"),
 (69, "Shahdol", "शहडोल", "", "MP"), (65, "Rajendragram", "राजेन्द्रग्राम", "", "MP"), (24, "Podki", "पोडकी", "", "MP"),
 (16, "Amarkantak", "अमरकंटक", "Source of the Narmada", "MP"),
]
PART3 = [  # Amarkantak → Omkareshwar, south bank, going west
 (0, "Amarkantak", "अमरकंटक", "Mai ki Bagiya, Gaumukh, Kabir Chabutra and more", "MP"),
 (25, "Karanjia", "करंजिया", "", "MP"), (35, "Dhawadongri", "धावाडोंगरी", "", "MP"), (10, "Gadhsarai", "गढ़सराय", "", "MP"),
 (31, "Dindori", "डिंडौरी", "", "MP"), (25, "Devnala Falls", "देवनाला प्रपात", "", "MP"), (25, "Chabhi", "चाभी", "", "MP"),
 (46, "Chikhli", "चिखली", "", "MP"), (10, "Madhupuri", "मधुपुरी", "", "MP"), (27, "Jargi", "जरगी", "", "MP"),
 (36, "Ghansaur", "घनसौर", "", "MP"), (21, "Diwari", "दिवारी", "", "MP"), (6, "Payli", "पायली", "Bargi Dam", "MP"),
 (8, "Tuniya", "टुनिया", "", "MP"), (25, "Mangeli", "मंगेली", "", "MP"), (24, "Tilwara", "तिलवारा", "", "MP"),
 (15, "Siwani", "सिवनी", "", "MP"), (10, "Nanhakheda", "नान्हाखेड़ा", "Shantidham Gangai", "MP"), (10, "Ghughari", "घुघारी", "", "MP"),
 (10, "Chargaon", "चारगांव", "", "MP"), (18, "Gotegaon", "गोटेगांव", "", "MP"), (37, "Narsinghpur", "नरसिंहपुर", "", "MP"),
 (35, "Barman", "बरमान", "", "MP"), (9, "Linga", "लिंगा", "", "MP"), (10, "Khulri", "खुलरी", "", "MP"), (12, "Bohani", "बोहानी", "", "MP"),
 (25, "Saikheda", "साईखेड़ा", "", "MP"), (5, "Tumda", "तूमड़ा", "", "MP"), (52, "Bankhedi", "बनखेड़ी", "", "MP"),
 (20, "Pipariya", "पिपरिया", "", "MP"), (10, "Shobhapur", "शोभापुर", "", "MP"), (11, "Sohagpur", "सोहागपुर", "", "MP"),
 (12, "Semri", "सेमरी", "", "MP"), (15, "Babai", "बाबई", "Village of the poet Makhanlal Chaturvedi", "MP"),
 (23, "Narmadapuram (Hoshangabad)", "होशंगाबाद", "", "MP"), (22, "Khoksar", "खोकसर", "", "MP"), (9, "Nanpa", "नानपा", "", "MP"),
 (9, "Aanwlighat", "आँवलीघाट", "", "MP"), (31, "Seoni Malwa", "सिवनी मालवा", "", "MP"), (41, "Harda", "हरदा", "", "MP"),
 (22, "Handia", "हंडिया", "", "MP"), (68, "Khirkiya", "खिरकिया", "", "MP"), (47, "Chhanera", "छनेरा", "", "MP"),
 (10, "Singaji Samadhi", "सिंगाजी समाधि", "", "MP"), (27, "Mundi", "मूँदी", "", "MP"), (52, "Sanawad", "सनावद", "", "MP"),
 (12, "Omkareshwar", "ओंकारेश्वर", "Parikrama complete", "MP"),
]
# a better search name where the display name is not a place name
SEARCH = {"Dhadgaon Phata": "Dhadgaon", "Statue of Unity": "Statue of Unity", "Mandu (Rewa Kund)": "Mandu",
          "Sitavan, Pipri": "Pipri", "Jayanti Mata Falls": "Jayanti Mata", "Shahpura (Jabalpur)": "Shahpura",
          "Shahpura (Dindori)": "Shahpura", "Saraswati Ghat": "Saraswati Ghat", "Narmadapuram (Hoshangabad)": "Narmadapuram",
          "Devnala Falls": "Devnala", "Bijhouli Fossil Park": "Ghughwa Fossil Park", "Nani–Moti Panoti": "Panoti",
          "Bhadpura": "Bhedaghat", "Singaji Samadhi": "Singaji", "Badrikashram": "Chandod", "Gangnath Mahadev": "Chandod"}

PARTS = [
 {"id": 1, "title": "Omkareshwar → Vimleshwar (sea coast)", "bank": "south", "dir": "west", "stated_km": 616,
  "stated": "Total to the sea coast: 616 km.", "stops": PART1},
 {"id": 2, "title": "Mithitalai → Amarkantak", "bank": "north", "dir": "east", "stated_km": 1775,
  "stated": "Mithitalai to Amarkantak about 1775 km – north bank, facing east.", "stops": PART2},
 {"id": 3, "title": "Amarkantak → Omkareshwar", "bank": "south", "dir": "west", "stated_km": 1040,
  "stated": "About 1040 km (the list says “Amarkantak to Vimleshwar 1040 km”).", "stops": PART3},
]
out = {"title": "Narmada Parikrama – Bike / Four-wheeler Route",
       "credit": {"by": "Acharya Shri Anildas Yogiraj", "place": "Shri Bhakti Ashram, Gomukh Ghat, Omkareshwar",
                  "phone": ["9981113661", "9165977556"],
                  "note": "Route list as published by the ashram; translated to English for this guide."},
       "boat": ("The boat from Vimleshwar to Mithitalai runs only from Dussehra to Akshaya Tritiya. "
                "Bikes and cars are carried across to Mithitalai for a fee while you travel by boat."),
       "parts": []}
for P in PARTS:
    cum, stops = 0, []
    for km, en, hi, note, st in P["stops"]:
        cum += km
        stops.append({"n": en, "hi": hi, "km": km, "cum": cum, "note": note, "state": st, "q": SEARCH.get(en, en)})
    out["parts"].append({k: v for k, v in P.items() if k != "stops"} | {"total_km": cum, "stops": stops})
    print(f"Part {P['id']}: {len(stops)} stops, sum {cum} km (list says {P['stated_km']})")
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "..", "data", "vehicle_route_src.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

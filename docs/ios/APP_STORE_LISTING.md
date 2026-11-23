# sHUttl for iPhone: App Store listing

Everything App Store Connect asks for, ready to paste. Where a field has a
character limit, the text below fits it (the counts are in brackets and were
checked by script, not by eye). Section order follows
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) Part 8.

Three rules this copy follows, and that any edit should keep:

1. **"Harvard" is never in the app name.** It appears only where it describes
   which shuttle network the app covers.
2. **Every place that names the network also says the app is independent.**
3. **Nothing is promised that the app does not do.** No "official", no
   "always accurate", no routes the tracker does not carry.

Fields marked **YOU** need something only you have (your name, a link you
create). Nothing else needs writing.

---

## 1. New app record

| Field | Value |
| :--- | :--- |
| Platform | iOS |
| Name | `sHUttl` (see fallbacks below) |
| Primary language | English (U.S.) |
| Bundle ID | `live.shuttl.app` (pick it from the list; it appears once Xcode has registered it, checklist step 28) |
| SKU | `shuttl-ios-1` (private, never shown; any unique string works) |
| User access | Full Access |

### App name (limit 30)

App names are unique across the whole App Store. Try them in this order and
use the first one App Store Connect accepts:

1. `sHUttl` [6]
2. `sHUttl: Live Shuttle Map` [24]
3. `sHUttl - Campus Shuttle Map` [27]

The name on the home screen is `sHUttl` whichever you pick; that comes from
`CFBundleDisplayName` in `frontend/ios/App/App/Info.plist`, not from here.

### Subtitle (limit 30)

Recommended:

```
Unofficial Harvard shuttle map
```
[30]

It says which network the app covers, which is what a student will search
for, and says "unofficial" in the same breath. If App Review objects to the
word "Harvard" (see the checklist's "If review rejects you"), switch to:

```
Live campus shuttle planner
```
[27]

---

## 2. Version information (the "1.0 Prepare for Submission" page)

### Promotional text (limit 170)

```
Live shuttle positions, arrival times and door-to-door trip plans for Harvard's campus shuttles. An independent student project, not affiliated with Harvard University.
```
[168]

### Description (limit 4000)

```
sHUttl shows where Harvard's campus shuttles are right now and tells you which one to catch.

NEXT BUS
Open the app and see what is leaving from the stops near you, with live arrival times. Prefer not to share your location? Pick a stop instead.

PLAN TRIP
Choose where you are starting and where you are going. sHUttl plans the whole trip: the walk to the stop, the shuttle to board, any transfer, and the walk at the other end. Plans are built from where the buses actually are, not only from where a timetable says they should be. Send a planned trip to a friend from the share sheet.

ROUTES
Pick a route to see only that route on the map, every stop it serves in order, and when its next buses reach each one.

THE M2
The M2 to Central, MIT, Kenmore and Longwood is on the map with live buses and arrival times, and Plan Trip will put you on it.

CLASSES
Add screenshots of your course enrollment page and sHUttl reads your classes from them. For each class in the coming week it works out which shuttle gets you there on time. Switch on Remind me and you get a notification when it is time to leave for the stop.

LIVE MAP
Every tracked shuttle on a fast, clean map, in dark or light, with your own position and a button to jump to it. Filter the map to the routes you care about. Stop closures, schedule changes and holiday service show up as notices on the map.

GOOD TO KNOW
- Free. No account, no sign-in, no ads.
- Your class schedule is kept on your phone. Schedule screenshots are sent to OpenAI to be read. Full details: https://shuttl.live/privacy.html
- Arrival times are estimates. Shuttles do not run at all hours, and when none are running the app says so.
- Also available in any browser at https://shuttl.live

sHUttl is an independent student project. It is not affiliated with, endorsed by or operated by Harvard University or the Longwood Collective. Shuttle positions come from the operators' public shuttle trackers.
```
[1,942]

### Keywords (limit 100, comma separated, no spaces)

Words already in the name or subtitle are indexed by Apple and should not be
repeated here, so there are two lists, one per subtitle.

With the recommended subtitle ("Unofficial Harvard shuttle map"):

```
bus,tracker,campus,transit,eta,trip,planner,cambridge,allston,quad,sec,arrival,route,class,student
```
[98]

With the fallback subtitle ("Live campus shuttle planner"), if you still
want the app to be findable by the network's name:

```
harvard,bus,tracker,transit,eta,trip,map,cambridge,allston,quad,sec,arrival,route,class,student
```
[95]

If the rejection that made you change the subtitle was about the Harvard
name, delete `harvard,` from this second list as well. Keywords are hidden
from users but not from App Review.

### URLs

| Field | Value |
| :--- | :--- |
| Support URL (required) | `https://github.com/pk-code-pk/sHUttl/issues` |
| Marketing URL (optional) | `https://shuttl.live` |
| Privacy Policy URL (required; it is on the App Privacy page) | `https://shuttl.live/privacy.html` |

The support URL only works if the GitHub repository is public. If it is
private, use `https://shuttl.live` instead and say so in the privacy page's
contact line too.

### Other fields on the version page

| Field | Value |
| :--- | :--- |
| Version | `1.0.0` (must match `MARKETING_VERSION` in the Xcode project, which is `1.0.0`) |
| Copyright | **YOU**: `2026` followed by your own legal name, e.g. `2026 Jane Doe`. Not "Harvard", not "sHUttl Inc." |
| What's New | Not shown for a first version; leave it. |
| Sign-in required | Off / No. The app has no login. |
| Release | "Manually release this version" is the safer choice for a first release: you choose the moment. |

---

## 3. App information

| Field | Value |
| :--- | :--- |
| Primary category | Navigation |
| Secondary category | Travel |
| Content rights | See below |
| Price | Free |
| Availability | All countries and regions. The app is only useful on one campus, but students' Apple accounts are registered all over the world, and a country you leave out is a student who cannot download it. |

### Content rights

App Store Connect asks whether the app contains, shows or accesses
third-party content. **The honest answer is yes**: the shuttle positions and
arrival predictions come from Harvard's shuttle tracker
(`shuttle.harvard.edu`), the timetable is transcribed from Harvard
Transportation's schedule page, and the background map is served by CARTO.

Answering yes then asks you to confirm you have the rights to use that
content. Nothing in this repository documents permission from Harvard to
reuse the tracker's data; the README describes the endpoints as undocumented
and keyless. Whether public, keyless access is permission enough is a
judgment only you can make. The durable answer is an email from Harvard
Transportation saying they are fine with it, which you can also attach if
App Review asks (see "If review rejects you" in the checklist).

### Age rating

Answer **None** (or **No**) to every question in the questionnaire. In
particular:

| Question area | Answer | Why |
| :--- | :--- | :--- |
| Violence, sexual content, profanity, drugs, gambling, horror, medical topics | None | The app is a map and a trip planner. |
| Unrestricted web access | No | There is no in-app browser. |
| User-generated content | No | Nothing a user enters is shown to any other user. |
| Messaging or chat | No | |
| Advertising | No | |
| In-app purchases, contests, loot boxes | No | |

The result should be the lowest rating (4+). The app is not "Made for Kids";
leave that off.

---

## 4. App Privacy

### Privacy policy URL

```
https://shuttl.live/privacy.html
```

It must load in a browser before you submit (checklist step 4).

### "Do you or your third-party partners collect data from this app?"

**Yes.**

Apple counts data as collected when it leaves the device and is kept longer
than it takes to answer the request. Most of what sHUttl sends is used once
and dropped, but four things do meet that definition. They are the same four
declared in the app's privacy manifest,
`frontend/ios/App/App/PrivacyInfo.xcprivacy`, and **the two must agree**: if
you change an answer here, change the manifest to match and rebuild.

| Data type (as App Store Connect groups it) | Collected | Purpose | Linked to the user | Used for tracking | What it actually is in the code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Location > **Precise Location** | Yes | App Functionality | Yes | No | Coordinates are sent with nearby-stop and trip requests and not stored. But with reminders on, a class starting within 60 minutes is saved with the phone's current coordinates (`origin_lat` / `origin_lng` in `reminders.py`) under the install's ID until the class starts. |
| Identifiers > **Device ID** | Yes | App Functionality | Yes | No | The random per-install `client_id`, and the APNs device token stored under it, both only when reminders are on. |
| User Content > **Other User Content** | Yes | App Functionality | Yes | No | Reminders: class title, room and start time for the next seven days, stored under the same ID until each class starts. |
| User Content > **Photos or Videos** | Yes | App Functionality | No | No | Schedule screenshots. `POST /parse-schedule` in `main.py` takes only the images (no ID), base64-encodes them in memory, sends them to OpenAI and returns the parsed classes. It never writes them to disk, Redis or a log. They are declared because OpenAI, a third-party partner, may retain API requests for a period under its own policy. |

Everything else: **not collected.** Specifically:

| Data type | Answer | Why |
| :--- | :--- | :--- |
| Contact Info (name, email, phone, address) | Not collected | There is no account and no form that asks. |
| Coarse Location | Not collected | Covered by Precise Location; do not tick both. |
| Usage Data, Diagnostics | Not collected | Vercel Analytics is rendered only on the website: `frontend/src/main.tsx` wraps it in `!isNativeApp()`. The app ships no analytics or crash-reporting SDK. |
| User ID, Advertising Data, Purchases, Financial Info, Health, Contacts, Browsing History, Search History, Sensitive Info | Not collected | None of it exists in the app. |

"Linked to the user" in Apple's sense includes data tied to a device or an
install, not just to a name. Location, the ID and the reminder content sit
together in the server's reminder store under one per-install ID, so they are
declared as linked. That is the cautious reading and the one the manifest
already uses. Screenshots carry no ID, so they are not linked.

"Used for tracking" is No throughout: nothing is combined with other
companies' data or shared for advertising, and `NSPrivacyTracking` is
`false` in the manifest.

---

## 5. App Review information

### Contact

**YOU**: your own first name, last name, phone number and email. Apple uses
them only to reach you about this review; they are not published.

### Attachments to prepare first

The reviewer cannot use the Classes tab or see a reminder without a schedule
screenshot, and they do not have a Harvard course enrollment page. Give them
one:

1. **YOU: a sample schedule screenshot.** A screenshot of your own enrollment
   page with your name and ID cropped out, or of a test page. Check that it
   imports correctly in the app first. Attach it in the App Review
   attachment field, and also put it somewhere it can be downloaded from a
   phone (an unlisted link).
2. **YOU: a screen recording made on your iPhone** (checklist step 46)
   showing: launch, the location prompt, Next Bus with real departures, a
   planned trip, the share sheet, importing the schedule, switching on
   Remind me with the notification prompt, and a reminder notification
   arriving and being tapped. Reminders fire about ten minutes before the
   rider has to be at the stop for a real class, so a reviewer cannot trigger
   one on demand; the recording is the proof it works. Upload it as an
   unlisted video and paste the link below.

### Notes (limit 4000)

Paste as is. The sample schedule screenshot is attached to the submission as a review attachment.

```
sHUttl is a live map and trip planner for the Harvard University campus shuttle network in Cambridge and Boston, Massachusetts, plus the M2 shuttle to Longwood. It is an independent student project and is not affiliated with or endorsed by Harvard University; the name of the university is used only to say which shuttle network the app covers.

NAME. The App Store and home-screen name is Crimson Shuttl. The logo inside the app reads sHUttl, the project's name; it is the same app as https://shuttl.live.

NO LOGIN. There is no account, no sign-in and no purchase. All features are available immediately.

HOW THE APP IS BUILT. The interface is bundled inside the app (Capacitor); it is not a website loaded at launch. Only live data (vehicle positions, arrival times, trip plans) is fetched from our API. Native features: location (While Using), push notifications through APNs, the system share sheet, haptics, and status bar and safe-area handling.

WHAT YOU WILL SEE, AND WHEN. Shuttles run mostly on weekdays from about 7:00 am to after midnight US Eastern Time, with less service on weekends and during university recesses. If you open the app when none are running, the map shows the stops without moving vehicles, Next Bus says "No buses running nearby. Shuttles may be out of service right now.", and Plan Trip may have no trip to offer. This is the app working as intended, not an error. A weekday between 9:00 am and 9:00 pm Eastern shows it at its best. Thanksgiving week: there are no regular shuttles on Thursday November 26 (one special All Cambridge shuttle runs 11 am to 7 pm) or Friday November 27; the app shows this as a notice on the map (the pill under the bus count).

IF YOU ARE NOT ON CAMPUS. Next Bus uses your location. Away from Cambridge it says "You are N km from the nearest stop ... Next Bus works on campus. Use Plan Trip to route from here." To see it as a rider would, tap the pin button at the top right of the Next Bus panel and choose any stop. In the Simulator, a custom location of 42.3744, -71.1169 (Harvard Yard) also works.

HOW TO TRY EACH FEATURE
1. Location: on first launch the app asks for location While Using the App. If you decline, it tells you where to turn it on and offers "Pick a stop"; everything works without location.
2. Trip planning: tap Plan Trip. In From type "Quad" and choose the stop; in To type "SEC" and choose the stop; tap the Plan Trip button. The route is drawn on the map with step-by-step directions.
3. Share sheet: with a trip planned, tap Share. The iOS share sheet opens with a link to the same trip.
4. Routes: tap Routes and choose any route marked as running. The map shows only that route and its buses, and the list shows each stop with its next arrivals. The locate button (top right of the map) centres the map on you.
5. Classes and schedule import: tap Classes, then Upload Screenshots. The app first asks permission to send the screenshots to OpenAI, a third-party AI service, which reads them into a class list; tap Allow. Then choose the sample schedule screenshot attached to this submission (made-up courses in real campus buildings). The app lists the classes it read and plans a shuttle for each upcoming one. Nothing is uploaded before Allow is tapped, and the question links to the privacy policy.
6. Push notifications: after a schedule is imported, a "Remind me" switch appears in Classes. Turning it on shows the iOS notification permission prompt. A reminder is then sent about 10 minutes before the rider needs to be at the stop for each class, so it cannot be triggered on demand.

PERMISSIONS. Location: to find nearby stops and plan from where the rider is. Camera and Photos: only when the rider chooses a schedule screenshot. Notifications: only for the leave-now reminders the rider switches on.

PRIVACY POLICY: https://shuttl.live/privacy.html (also linked inside the app: on the first-launch screen and at the end of the Classes tab)
```
[3,946]

Before pasting, check three things against the build you are submitting,
because they were written from the code and not from a running app:

- that typing "Quad" and "SEC" in Plan Trip does offer stops with those names
  (the stop list comes live from the tracker and names can change);
- what Plan Trip actually shows late at night when nothing is running, and
  reword the "may have no trip to offer" sentence if it is something else;
- that the pin button and the "Remind me" switch are where the notes say.

---

## 6. Screenshots

An iPhone-only app needs iPhone screenshots only; no iPad set. App Store
Connect asks for the largest iPhone size and scales it down for the others,
and shows the exact pixel sizes it accepts next to the upload area. A
screenshot saved from the largest iPhone simulator is one of the accepted
sizes. How to take them is checklist steps 47 to 49.

Between three and five is plenty (the limit is ten). Suggested set, in this
order, taken while shuttles are running:

1. The live map with several shuttles visible, panel at rest.
2. Next Bus with real departures listed.
3. A planned trip: route drawn on the map, itinerary open.
4. Classes with a week of classes and their shuttle plans.
5. The light basemap, for contrast with the first.

Rules that get screenshots rejected: they must be of the real app, must not
show another platform's status bar, and must not show a Harvard shield or
logo. A plain screenshot with no added caption is acceptable and is the
least work.

---

## 7. Where each claim in this file comes from

So that a later edit can be checked the same way.

| Claim | Source |
| :--- | :--- |
| No login, no account | No auth code anywhere in `frontend/src`; `client_id` is a random UUID (`frontend/src/lib/reminders.ts`). |
| Analytics off in the app | `frontend/src/main.tsx`: `{!isNativeApp() && <Analytics />}`. |
| Screenshots not stored by the server | `api_parse_schedule` in `main.py`: reads each upload into memory, base64-encodes it into the OpenAI request, returns the parsed list. The only log line on that path is the first 500 characters of the model's reply when it is not valid JSON. |
| What a reminder holds | `ReminderIn` in `main.py` and `normalize_reminder` in `reminders.py`. |
| Reminder retention | `run_tick` and `is_expired` in `reminders.py`: a reminder is dropped once `arrive_by` has passed; the tick runs every 60 seconds. `LOOKAHEAD_HOURS = 168` in `ClassesPanel.tsx` is the seven days. |
| Location saved only for a class within the hour | `GPS_HORIZON_MINUTES = 60` and `originForEach` in `frontend/src/components/ClassesPanel.tsx`. |
| Reminder lead time of ten minutes | `LEAD_MINUTES = 10` in `ClassesPanel.tsx`. |
| Service hours | `harvard_schedule.py`, transcribed from Harvard Transportation's schedule page for 2025-26. |
| Empty-state wording quoted to the reviewer | `frontend/src/components/NextBusPanel.tsx`. |
| Permission asked before screenshots go to OpenAI | `loadAiConsent`, `openPicker` and `UploadConsent` in `frontend/src/components/ClassesPanel.tsx`; asked in the app only, once, and remembered on the device. |
| Privacy policy linked inside the app | `frontend/src/components/PrivacyLink.tsx`, used by `SystemSelectModal.tsx` (first launch) and `ClassesPanel.tsx`. |
| Privacy manifest contents | `frontend/ios/App/App/PrivacyInfo.xcprivacy`. |

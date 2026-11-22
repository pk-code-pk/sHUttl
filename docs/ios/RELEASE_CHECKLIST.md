# sHUttl for iPhone: release checklist

Everything between "the code is written" and "the app is on the App Store",
in order. Do the steps from top to bottom; each one is a single action with
the result you should see. The text to paste into App Store Connect is in
[`APP_STORE_LISTING.md`](APP_STORE_LISTING.md).

**Read this first.** The iOS work was done on Linux. The project compiles:
the `iOS build` job in GitHub Actions builds it, unsigned, on a macOS runner
(see [No Mac: build in the cloud](#no-mac-build-in-the-cloud)). It has never
been signed, installed or run, on an iPhone or in a simulator; its behaviour
was checked against the installed packages' own sources and against a mocked
bridge in a desktop browser. Expect the first run on a phone to need some
fixing. What
exactly was and was not checked is listed in
[What was not verified](#what-was-not-verified), and Part 7 is the test that
finds the problems.

Throughout, `BACKEND` means the address of your deployed API, for example
`https://your-service.onrender.com`. Step 2 tells you where to find it.

## What you need

| Thing | Why | Cost |
| :--- | :--- | :--- |
| Apple Developer Program membership | Signing a build that uses push notifications, TestFlight, and the App Store all require it. A free Apple account cannot sign this app, because the project carries the push entitlement. | US$99 a year (Apple's price; it differs by country) |
| A Mac with a current Xcode | iOS apps can only be built, signed and uploaded from macOS. | See step 17 if you do not have one |
| An iPhone on iOS 15 or later, and its cable | The project's deployment target is iOS 15.0. Push reminders must be tested on a real phone. | |
| Access to the backend host's dashboard | To set the `APNS_*` variables and redeploy. | |
| Access to wherever the website deploys from | The privacy policy page ships with the website. | |

## Open item

One thing is not done in code, because only you can do it. It does not stop
you building and testing, and it must be settled before step 52 (submitting
for review).

**A reviewer cannot reach Classes or reminders without a schedule
screenshot**, and has no Harvard enrollment page to take one from. You supply
a sample screenshot and a screen recording: steps 46 and 50.

Three things an earlier draft of this checklist listed here are now handled
in the code, and Part 7 tests them: the app links the privacy policy (from
the first screen of a fresh install and from Classes); it asks permission
before the first schedule screenshot is sent to OpenAI; and the sentence
under the upload button no longer makes a claim about what OpenAI keeps.

---

## Part 1: Put the finished code live

The app talks to the same backend as the website, and the privacy policy is a
page on the website, so both deploy before anything Apple-related.

1. **Commit and push the iOS work.** In the repository run `git status`. It
   should list nothing uncommitted once you are done. The new work includes
   `frontend/ios/`, `frontend/capacitor.config.ts`, `frontend/assets/`,
   `frontend/public/privacy.html`, `frontend/scripts/`, `docs/ios/`,
   `validate_apns.py`, and changes to `main.py`, `reminders.py`,
   `requirements.txt`, `.gitignore` and files under `frontend/src/`.
   Pushing to the branch the website deploys from also publishes the web
   changes; that is intended, and step 4 checks the result.
   *Expect:* `git status` says "nothing to commit, working tree clean".

2. **Find your backend's address.** It is the value of `VITE_API_BASE_URL` in
   the environment variables of the project that builds the website
   (`frontend/FRONTEND_DEPLOYMENT.md` has you set it there). Write it down
   without a trailing slash. This is `BACKEND` from here on.

3. **Redeploy the backend from the pushed commit.** `requirements.txt` gained
   `httpx[http2]` and `cryptography`, so the image must be rebuilt, not just
   restarted. `DEPLOYMENT_BACKEND.md` describes the deployment; the code's
   comments assume the host is Render.
   *Expect:* `curl BACKEND/health` prints `{"status":"ok"}`.

4. **Check the website and the privacy page.** Open `https://shuttl.live` in
   a browser and plan a trip as you normally would, then open
   `https://shuttl.live/privacy.html`.
   *Expect:* the site behaves exactly as before, and the privacy page loads
   as a dark page titled "Privacy". If it shows the map instead, the website
   has not redeployed yet.

5. **Check the new endpoint exists.** Run `curl BACKEND/push/config`.
   *Expect:* `{"web_push":true,"vapid_public_key":"B...","apns":false}`.
   `apns` is `false` at this point; that is correct. (`web_push` is `true`
   only if the `VAPID_*` variables are set.) A 404 means the backend is still
   running the old code.

6. **Confirm `REDIS_URL` is set on the backend host.** Look in the host's
   environment variables.
   *Why:* without Redis, reminders and device tokens live in a file that is
   wiped on every deploy (see the top of `reminders.py`), and phones silently
   stop getting reminders.

## Part 2: Join the Apple Developer Program

Start this early. Approval is usually quick but can take a couple of days,
and nothing in Parts 3 to 11 works without it.

7. **Make sure your Apple Account has two-factor authentication on.** Apple
   requires it for developer accounts.

8. **Enrol as an individual.** Go to
   [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll)
   and follow it through, choosing to enrol as an individual (not as an
   organisation, which needs a registered company).
   *Know before you do:* for an individual membership, the seller name shown
   on the App Store is your legal name.

9. **Pay and wait for the confirmation email.** Do not continue until
   [developer.apple.com/account](https://developer.apple.com/account) shows
   your membership as active.

## Part 3: Give the backend its Apple push key

The server signs each notification with a key from your Apple account. This
part needs no Mac. `DEPLOYMENT_BACKEND.md` section 2 covers the same ground
in more detail.

10. **Create the key.** At
    [developer.apple.com/account](https://developer.apple.com/account) open
    **Certificates, Identifiers & Profiles**, then **Keys**, and add a key.
    Name it anything (for example "sHUttl APNs"), tick **Apple Push
    Notifications service (APNs)**, and register it. If Apple asks which
    environment the key is for, choose the option that covers both sandbox
    and production.

11. **Download the `.p8` file and put it somewhere safe outside the
    repository folder.** Apple lets you download it exactly once. It is
    named `AuthKey_XXXXXXXXXX.p8`. A password manager is a good place. Never
    commit it, email it or paste it into a chat. (The repository ignores
    `*.p8` files so a stray copy cannot be committed by accident, but that is
    a safety net, not a place to keep it.)

12. **Write down the Key ID.** It is the 10 characters shown on the key's
    page, and the `XXXXXXXXXX` in the file name.

13. **Write down your Team ID.** It is a 10-character code shown in your
    account's membership details on the same site.

14. **Set the variables on the backend host.** In the host's environment
    settings:

    | Variable | Value |
    | :--- | :--- |
    | `APNS_KEY_ID` | The Key ID from step 12. |
    | `APNS_TEAM_ID` | The Team ID from step 13. |
    | `APNS_AUTH_KEY` | The whole contents of the `.p8` file, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Paste it with its line breaks if the dashboard takes multi-line values; otherwise put it on one line with each line break written as `\n`. Mark it as a secret if the host has that option. |
    | `APNS_BUNDLE_ID` | **Leave unset.** It defaults to `live.shuttl.app`. Set it only if you change the bundle ID in step 29. |
    | `APNS_ENVIRONMENT` | **Leave unset.** It defaults to `production`. Builds run from Xcode get sandbox tokens; the server retries a rejected token against the other environment and remembers which worked, so one deployment serves both. |

15. **Redeploy or restart the backend** so it reads the new variables.

16. **Confirm the server can use the key.** Run `curl BACKEND/push/config`.
    *Expect:* `"apns":true`.
    *If it is still `false`:* one of the three variables is missing, or the
    key could not be read. The backend log says which. The usual cause is a
    key pasted without its BEGIN/END lines or with the line breaks lost.
    Until this says `true`, the Remind me switch does not appear in the app.

## Part 4: Set up a Mac

17. **Get the use of a Mac.** There is no way to build, sign or upload an
    iOS app from Windows or Linux. If you do not own a Mac, the honest
    options are:
    - **Borrow one**, or use one in a campus computer lab if Xcode is
      installed there. A few hours across two or three sittings is enough.
    - **Rent a Mac in the cloud** by the hour or month (several companies
      sell this; search "rent a Mac in the cloud"). You get a remote desktop
      with Xcode. Plugging in your own iPhone is not possible, so on-device
      testing has to go through TestFlight (Part 9) instead of step 32.
    - **Build in the cloud with GitHub Actions.** This repository has two
      jobs for it, and the repository is public, so the macOS runners cost
      nothing. See [No Mac: build in the cloud](#no-mac-build-in-the-cloud).
      It replaces Parts 4 to 6 and steps 40 to 42; on-device testing then
      goes through TestFlight (Part 9) instead of step 32. The upload job has
      not been run yet, because it needs your Apple account.

18. **Install Xcode from the Mac App Store**, open it once, and let it
    install the iOS components it offers. Use the current release: Capacitor
    8 and App Store uploads both require a recent Xcode. The download is
    large; allow an hour.

19. **Sign Xcode in to your Apple Account.** In Xcode's Settings window, open
    the Accounts section and add the Apple Account that holds the developer
    membership.
    *Expect:* your team is listed there, and not only as "(Personal Team)".

20. **Install Node.js 22.12 or newer.** From [nodejs.org](https://nodejs.org)
    or with a version manager.
    *Expect:* `node -v` prints `v22.12.0` or higher. (`@capacitor/cli` needs
    22; Vite needs 22.12.)

## No Mac: build in the cloud

Skip this section if you are using a Mac; carry on with Part 5.

Two GitHub Actions jobs live in `.github/workflows/`:

| Job | What it does | Needs |
| :--- | :--- | :--- |
| `iOS build` (`ios-build.yml`) | Compiles the app, unsigned, for the simulator and for a device. Runs by itself on every push that touches `frontend/`. | Nothing |
| `iOS TestFlight` (`ios-testflight.yml`) | Builds, signs and uploads a build to App Store Connect. Run by hand. | The four secrets and one variable below |

The upload job is **untested**: it could not be run without an Apple
Developer account. It uses Xcode's automatic signing, authenticated with an
App Store Connect API key. If it fails, the job's log (and the
`xcodebuild-logs` attachment on the failed run) names the step.

Do Parts 1 to 3 first. Then:

- **Register the bundle ID.** With a Mac, Xcode does this in step 28;
  without one you do it by hand. In your Apple Developer account open
  Certificates, Identifiers & Profiles, go to Identifiers, and add an App ID
  with the bundle ID `live.shuttl.app` and the Push Notifications capability
  ticked. If the name is taken, pick another and change `appId` in
  `frontend/capacitor.config.ts`, `PRODUCT_BUNDLE_IDENTIFIER` (twice) in
  `frontend/ios/App/App.xcodeproj/project.pbxproj`, and `APNS_BUNDLE_ID` on
  the backend to match.
- **Do Part 8** (create the app record). The upload is refused unless the
  record already exists in App Store Connect.

- **Create an App Store Connect API key.** In App Store Connect, open Users
  and Access and find the section for integrations and API keys. Create a
  team key with the **Admin** role (automatic signing has to create signing
  assets, which lesser roles cannot). Download the `.p8` file; it can be
  downloaded once. Note the **Key ID** beside the key and the **Issuer ID**
  shown above the list. This is a different key from the push key in Part 3.
- **Find your Team ID.** It is the ten-character code on the membership
  page of your Apple Developer account.
- **Add the secrets.** In the GitHub repository open Settings, then Secrets
  and variables, then Actions. Under Secrets add:
  - `ASC_KEY_ID`: the Key ID
  - `ASC_ISSUER_ID`: the Issuer ID
  - `ASC_PRIVATE_KEY`: the whole contents of the `.p8` file, including the
    `BEGIN` and `END` lines
  - `APPLE_TEAM_ID`: the Team ID
- **Add the variable.** On the same page, under Variables, add
  `VITE_API_BASE_URL` with the `https://` address of the backend (`BACKEND`).
- **Merge this work into the default branch.** GitHub only offers a
  hand-run job once its file is on the default branch.
- **Run it.** In the repository's Actions tab choose `iOS TestFlight`, then
  Run workflow.
  *Expect:* a green run after roughly ten minutes, then the build appearing
  in App Store Connect under TestFlight as in step 43. The build number is
  the job's run number, so there is nothing to raise by hand between
  uploads.

Then continue from step 43. Everything in Part 7 is tested on the TestFlight
build instead of an Xcode build.

## Part 5: Build the app bundle

The iOS app is the same web build as the website, copied into the Xcode
project. Three generated things inside `frontend/ios` are not in git
(`App/App/public`, `capacitor.config.json`, `config.xml`), so **Xcode cannot
build a fresh clone until step 24 has run.**

21. **Clone the repository.**
    ```bash
    git clone https://github.com/pk-code-pk/sHUttl.git
    cd sHUttl/frontend
    ```

22. **Install the dependencies exactly as locked.**
    ```bash
    npm ci
    ```

23. **Tell the build where the backend is.** Create the file
    `frontend/.env.production` containing one line, with your real address
    from step 2:
    ```
    VITE_API_BASE_URL=https://your-service.onrender.com
    ```
    It must be a full `https://` address with no trailing slash. The file is
    ignored by git, so it has to be created on each machine.
    *Why this matters:* inside the app the page's own address is
    `capacitor://localhost`, so without a full address the app cannot reach
    the API at all. The next step refuses to run if the value is missing or
    is not an `https://` address; it cannot tell whether it is the *right*
    address, which is what step 25 is for.

24. **Build the web app and copy it into the iOS project.**
    ```bash
    npm run ios:sync
    ```
    This checks `VITE_API_BASE_URL` (`scripts/check-ios-env.mjs`), runs
    `tsc -b && vite build`, and then `cap sync ios`.
    *Expect:* the first line printed is "iOS bundle will talk to" followed
    by your backend address, it ends without an error, and
    `frontend/ios/App/App/public/` now exists. **Run this again after every `git pull` or code change**;
    Xcode does not do it for you.

25. **Check the backend address really is in the bundle.** Substitute your
    host name:
    ```bash
    grep -l "your-service.onrender.com" ios/App/App/public/assets/*.js
    ```
    *Expect:* at least one file name is printed. If nothing is printed,
    step 23 was not picked up; fix it and repeat step 24.

26. **Open the project in Xcode.**
    ```bash
    npm run ios:open
    ```

## Part 6: Sign it and run it on your iPhone

27. **Wait for Xcode to fetch the Swift packages.** The first time, Xcode
    downloads Capacitor's native code; progress shows at the top of the
    window. It needs a network connection.

28. **Choose your team.** In the left sidebar click the blue **App** project
    at the very top. In the editor select the **App** target, then the
    **Signing & Capabilities** tab. Keep automatic signing ticked and pick
    your team in the Team menu (your name, not the entry marked "Personal
    Team").
    *Expect:* the red signing errors clear after a few seconds. Xcode has
    now registered the bundle ID `live.shuttl.app` with your account.

29. **Change the bundle ID only if Xcode says `live.shuttl.app` is not
    available.** Bundle IDs are unique across all Apple developers. If and
    only if you see that error:
    - type a new one in the Bundle Identifier field, for example
      `live.shuttl.ios`;
    - change `appId` in `frontend/capacitor.config.ts` to the same value;
    - set `APNS_BUNDLE_ID` on the backend to the same value and redeploy;
    - run `npm run ios:sync` again.

    All three places must match or notifications will be rejected by Apple.

30. **Confirm Push Notifications is listed.** Still on Signing &
    Capabilities, look down the list of capabilities.
    *Expect:* "Push Notifications" is there; it comes from the file
    `App/App.entitlements` already in the project. If it is not, use the
    button for adding a capability at the top of that tab and add Push
    Notifications once.

31. **Connect your iPhone.** Plug it in, unlock it, and accept the prompt to
    trust the computer. If the phone or Xcode says Developer Mode is needed,
    turn it on in the phone's Settings under Privacy & Security and let the
    phone restart.

32. **Run the app.** Pick your iPhone in the device menu in Xcode's toolbar
    and press the Run button (or Cmd+R).
    *Expect:* the app installs and opens on the phone. The first build takes
    a few minutes. If the build fails, read the first red error, not the
    last; see [What was not verified](#what-was-not-verified) for the files
    most likely to be at fault.

33. **Commit the package lock file Xcode just created.**
    `frontend/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
    pins the native package versions and is meant to be in git.

## Part 7: Test on the phone

34. **Work through every row below on your iPhone and note anything that
    does not match.** This is the first time any of it runs on iOS. Do it
    on a day and at a time when shuttles are running, ideally on campus.

    | # | Do this | You should see |
    | :--- | :--- | :--- |
    | a | Delete the app if installed, run it fresh, and watch the launch. | A dark launch screen with the logo, then the animated logo, then the map. No white flash. The clock and battery at the top are readable throughout. |
    | b | Wait for the location prompt and allow it while using the app. | The iOS location prompt appears during or just after the logo animation, showing the sentence from `Info.plist` about finding nearby stops. |
    | c | Look at Next Bus Out. | "Nearest:" and a stop name, and departures listed. Off campus: "You are N km from the nearest stop" and a pointer to Plan Trip. |
    | d | Look at the edges of the screen. | The status pill at top left and the buttons at top right sit below the notch or Dynamic Island. The bottom sheet clears the home indicator. |
    | e | Drag the bottom sheet up and down; pinch and pan the map; press and hold a button. | The sheet snaps with a light tap of haptic feedback. The map zooms and pans normally. Holding a button does not select text or show a copy menu. |
    | f | Tap the map style button to switch to the light map and back. | The clock and battery stay readable on both. |
    | g | Tap Plan Trip, tap into From and To and type stop names, choose two stops, tap Plan Trip. | The keyboard appears and the fields can be typed in; the screen returns to normal when the keyboard closes. A route is drawn and an itinerary shown. A light haptic on Plan Trip. |
    | h | With the trip showing, tap Share. Cancel the sheet once, then tap Share again and send the link to yourself. | The iOS share sheet opens. Cancelling shows no error. The link is `https://shuttl.live/?from=...&to=...` and opens the same trip on the website. |
    | i | Tap Classes, then Upload Screenshots. When the question "Send your screenshots to OpenAI?" appears, tap Not now, tap Upload Screenshots again, and this time tap Allow. Choose screenshots of your enrollment page. | Not now uploads nothing and brings the upload button back. Allow opens the picker straight away, offering your photo library (and the camera). After a few seconds your classes are listed with a shuttle plan for the upcoming ones. The question is not asked again, including when you add more screenshots with the camera button at the top of Classes. |
    | j | Find the "Remind me" switch near the top of Classes and tap it. | The iOS notification prompt appears. After allowing, the switch turns on within a few seconds. |
    | k | Close the app completely (swipe it away) and wait for your next class that has a shuttle plan. | A "Leave now for ..." notification arrives about ten minutes before you need to be at the stop. |
    | l | Tap that notification. | sHUttl opens. |
    | m | Next time, leave the app open on screen when a reminder is due. | The notification shows as a banner over the app. |
    | n | Close and reopen the app. | Remind me is still on. |
    | o | Tap Remind me to turn it off. | It turns off without an error, and no further reminders arrive. |
    | p | Delete and reinstall, and this time refuse location. | A message that location is off for sHUttl with where to turn it on, and a way to pick a stop. Check that the Settings path in the message is right for your iOS version. |
    | q | Turn on Airplane Mode and launch the app. | The launch screen goes away (within about six seconds at worst) and the app's own interface appears, with messages that data could not be loaded, rather than a blank white or black screen. |
    | r | In Classes, drag the sheet up, scroll to the very end of the list and tap "Privacy policy". On a fresh install, also look for the same link on the first screen, under the Harvard Shuttles button. | Safari opens `https://shuttl.live/privacy.html`. Switching back to sHUttl shows the app where you left it, not the privacy page. |
    | s | Drag the bottom sheet all the way up. | It stops just below the status pill and the four round buttons, which stay visible and tappable. The end of a long list scrolls clear of the home indicator. |
    | t | Switch to the light map. In Classes tap the camera button, choose to take a photo, then cancel the camera. | The clock and battery are still dark and readable over the light map. If they have turned white, switching the map style twice puts them right; note it as a known gap (see [What was not verified](#what-was-not-verified)). |

    **If the Remind me switch never appears (row j):**
    `curl BACKEND/push/config` is not returning `"apns":true` (step 16), or
    the bundle was built without the right `VITE_API_BASE_URL` (step 25).

    **If turning it on fails after about 15 seconds with "Could not set up
    notifications on this device":** iOS did not hand the app a device token.
    Check step 30, and that the team in step 28 is the paid one.

    **If the switch turns on but no reminder ever arrives (row k):** first
    check that the class card in Classes actually shows a shuttle plan (a
    class you would walk to gets no reminder). Then look in the backend log
    around the time it was due. A line saying APNs rejected the credentials
    with a 403 means the Key ID, Team ID and key from Part 3 do not belong
    together. A line saying APNs rejected the topic means `APNS_BUNDLE_ID`
    on the backend is not the bundle ID the app was built with (step 29).

    Fix what you find, run `npm run ios:sync`, press Run again, and repeat
    the rows that failed before going on.

## Part 8: Create the app in App Store Connect

All the text for this part is in
[`APP_STORE_LISTING.md`](APP_STORE_LISTING.md), in the same order.

35. **Create the app record.** Sign in at
    [appstoreconnect.apple.com](https://appstoreconnect.apple.com), open the
    apps list, and add a new app. Fill the form from listing section 1.
    *If `live.shuttl.app` is not in the Bundle ID menu:* step 28 has not
    been done with this Apple account yet.

36. **Fill in the app information.** Subtitle, categories, the content
    rights question and the age rating questionnaire, from listing sections 1
    and 3. Read the paragraph on content rights before you answer it; it is
    a decision, not a formality.

37. **Set the price to Free and choose availability**, from listing
    section 3. If App Store Connect asks you to declare whether you are a
    trader under the EU's Digital Services Act before it will distribute in
    the EU, answer it truthfully for your situation; Apple's own help text on
    that screen explains the two choices.

38. **Fill in App Privacy.** Enter the privacy policy URL
    `https://shuttl.live/privacy.html`, then answer the data questionnaire
    exactly as in listing section 4, and publish the answers.

39. **Fill in the version page.** Promotional text, description, keywords,
    support URL, marketing URL, copyright and version number from listing
    section 2.

## Part 9: Upload a build and test it through TestFlight

A TestFlight build is signed the way the App Store build will be and uses
Apple's production push service, so this is the real test of reminders.

40. **Select the generic device.** In Xcode's device menu choose the entry
    for any iOS device (not a simulator and not your own phone).

41. **Archive.** In the Product menu choose Archive.
    *Expect:* after the build, the Organizer window opens showing the
    archive. If Archive is greyed out, step 40 was not done.

42. **Upload it.** In the Organizer, select the archive, choose to
    distribute the app, pick the App Store Connect option, and accept the
    defaults through to upload.
    *Expect:* "Upload successful" or similar. The export-compliance question
    is already answered by `ITSAppUsesNonExemptEncryption` in `Info.plist`.

43. **Wait for processing.** In App Store Connect open the app's TestFlight
    tab. The build appears as processing and becomes available after a
    while (often 10 to 30 minutes). Apple emails you if it finds a problem
    with the upload; fix what the email names, raise the build number
    (below), and repeat steps 40 to 42.

    *Build numbers:* every upload needs a higher build number than the last.
    In Xcode, on the App target's General tab, the Build field starts at `1`;
    make it `2` for the second upload, and so on. The Version stays `1.0.0`.

44. **Install the TestFlight build on your iPhone.** In the TestFlight tab,
    add yourself to an internal testing group, install Apple's TestFlight
    app from the App Store on your phone, and install sHUttl from it.

45. **Repeat Part 7 rows i to o on the TestFlight build.** Turn Remind me
    off and on again in this build so the phone registers a fresh token.
    *Expect:* a reminder arrives for your next class. If reminders worked
    from Xcode but not from TestFlight, the problem is the production push
    environment; check the backend log for the line about that device token.

46. **Record the demonstration video.** Use the iPhone's built-in screen
    recording while running the TestFlight build, and capture what listing
    section 5 lists, ending with a real reminder arriving and being tapped.
    Upload it somewhere it can be viewed by link without signing in.

## Part 10: Screenshots

An iPhone-only app needs iPhone screenshots only.

47. **Run the app in the largest iPhone simulator.** In Xcode's device menu
    pick the largest current iPhone simulator (the "Pro Max" model) and
    press Run.

48. **Give the simulator a campus location.** In the Simulator app's menu
    bar, find the location setting (under Features) and enter a custom
    location of latitude `42.3744`, longitude `-71.1169`. Do this while
    shuttles are running so the map has vehicles on it.

49. **Save and upload the screenshots.** With the Simulator in front, save a
    screenshot (Cmd+S) of each screen listed in listing section 6, then drag
    the files into the iPhone screenshot area of the version page. App Store
    Connect shows the pixel sizes it accepts and rejects anything else on
    the spot.

## Part 11: Submit for review

50. **Fill in App Review Information** on the version page from listing
    section 5: your contact details, sign-in not required, the notes with
    your two links filled in, and the sample schedule screenshot attached.

51. **Attach the build.** In the Build section of the version page, select
    the build you tested in step 45.

52. **Check the open item at the top of this file is closed, then
    submit.** Use the button on the version page that adds the version for
    review and confirm the submission.
    *Expect:* the status changes to "Waiting for Review". Most reviews
    finish within a few days; you get an email either way.

53. **Release it.** If you chose manual release, press the release button
    once the status is "Pending Developer Release". The app appears on the
    App Store within a few hours.

---

## What was not verified

Plainly: **none of the iOS work has been run.** It was written on Linux,
where there is no Xcode. The one thing confirmed since is that it compiles:
the `iOS build` job builds the project unsigned on a macOS runner. Nothing
has been signed, installed or launched. The list below is what each part's
author could not confirm. Part 7 exercises nearly all of it.

**The Xcode project**

- `project.pbxproj`, `AppDelegate.swift`, `LaunchScreen.storyboard` and the
  asset catalog build without errors in the `iOS build` job. That job does
  not sign, so `App.entitlements` has never been applied to a build, and
  nothing has checked `PrivacyInfo.xcprivacy` beyond that it parses.
- The `iOS TestFlight` job has never been run.
- That automatic signing turns on Push Notifications for the App ID from the
  entitlements file alone, and that a distribution build gets the production
  push entitlement in place of `development`. Both are how Xcode normally
  behaves, neither was observed.
- That a free "Personal Team" cannot sign the app because of the push
  entitlement. Believed, not tested.
- Whether App Store Connect accepts the privacy manifest as written, and
  whether the Swift package fetched for geolocation uses any "required
  reason" API beyond the one declared.
- `npm run ios:sync` and `npm run ios:open` were not executed as written.
  The pieces were run separately on Linux (the address check, the web build,
  and `npx cap sync ios`), with a placeholder backend address, so the copy of
  the web build inside `frontend/ios` on the development machine points
  nowhere. That, and the fact that it is not in git, is why step 24 is not
  optional.

**Launch and layout**

- That the launch screen hands over to the animated logo with no flash. The
  launch image shows the logo where the animation draws it, but the
  animation starts from transparent, so the logo may blink out and back.
- Status bar text colour during launch and over both map styles. One case
  is expected to be wrong and could not be fixed blind: the status-bar
  plugin puts the text back to white whenever the app's main screen
  reappears from behind a full-screen system screen such as the camera, so
  on the light map the clock may turn white until the map style is next
  switched (Part 7 row t).
- That the fully raised sheet stops below the map's buttons on every iPhone
  size, and that the end of a long list clears the home indicator there.
  Measured in a desktop browser emulating one notched phone.
- Safe-area handling was checked only with a desktop browser's emulation:
  the top offsets, the lift of the bottom sheet above the home indicator,
  and whether the inset values are available when the sheet first renders.
- The six-second fallback that removes the launch screen if the web bundle
  fails to start.
- The CSS that stops text selection and the long-press menu, and that text
  fields stay editable and map pinch-zoom still works with it, in iOS's web
  view.
- How the screen moves when the keyboard opens over the From and To fields.
  There is no keyboard plugin installed.
- Haptics: that they feel right and are not too frequent.
- iPad. The app is iPhone-only and will run on iPad in the scaled iPhone
  mode; that was not looked at.
- The icon on a real home screen. It is a wide wordmark on white and will be
  small at icon size; there are no dark or tinted variants.

**Classes**

- That tapping Allow on the OpenAI question opens the photo picker on iOS.
  The picker is opened from inside that tap, which is what WebKit requires,
  and it works in desktop Chromium; it has not been tapped on a phone.
- That the "Privacy policy" links open Safari and leave the app in place.
  Read from Capacitor's source, where any link away from the bundled page is
  handed to the system; not tapped on a phone.

**Location and sharing**

- The real location prompt, the "Allow Once" path, and the plugin's error
  codes arriving in the form the code expects.
- Whether a ten-second, low-accuracy fix is long enough indoors on campus.
- The Settings path quoted in the "location is off" message.
- That the share sheet's cancel is recognised as a cancel and not shown as
  an error.

**Push reminders**

- The whole path on a device: permission, token, registration with the
  server, delivery, banner while open, and opening the app from a tap. The
  client was tested against a mock of the plugin; the server against a mock
  of Apple.
- A successful delivery by Apple. The server's code reached Apple's sandbox
  with throwaway credentials and was correctly refused; it has never sent a
  notification that arrived.
- The automatic fallback between Apple's sandbox and production
  environments, which relies on Apple answering a wrong-environment token
  the way its documentation says.
- That the notification's `url` and `reminder_id` reach the app on tap. The
  server only ever sends `/` today, so the code path that reloads the app
  onto a specific trip has never run anywhere.
- If notification permission is revoked in iOS Settings after reminders
  were turned on, the switch in the app still reads on. The website has the
  same gap.
- Native subscriptions in the Redis store. Tests used the file store; the
  code path is shared with web subscriptions.

**The website**

- The live site was not opened in a browser after these changes. The web
  path was checked by reading the diff, by a production build, and by
  automated checks in desktop Chromium against a mocked API. Step 4 is the
  real check.
- Two things website users can notice. The small print under Upload
  Screenshots in Classes now reads "sHUttl does not keep them; OpenAI
  handles them under its own API terms. Your schedule stays on this device
  unless you turn on reminders." And reminders for a class that directly
  follows another now arrive: the server used to drop the "coming from the
  previous class's room" detail, was left with no starting point, and never
  sent those reminders on any platform.
- Two small behaviour changes on `POST /push/subscribe` for web clients: a
  body with no subscription still returns 422 but with a different message,
  and a body carrying both a browser subscription and an Apple token is now
  rejected where the extra field used to be ignored.

**These documents**

- Apple's screens change. Menu names and button labels in Parts 2, 3, 6, 8,
  9 and 11 are described from memory of Apple's sites and of Xcode, not read
  off them. Where a label here does not match, look for the nearest
  equivalent; the order of operations is what matters.
- The accepted screenshot sizes, the wording of the age-rating and
  content-rights questions, the EU trader question, and review times are
  Apple's to change.
- What Plan Trip shows when no shuttles are running, and the exact stop
  names a reviewer should type, were inferred from the code. The listing
  file says where to check them.
- Whether the GitHub repository is public. The privacy page and the support
  URL both point to its issues page.
- The description of OpenAI's and Vercel's own data handling in
  `privacy.html` is taken from those companies' published statements as of
  writing, not from anything in this repository.

## If review rejects you

A rejection is a message, not a verdict. It arrives in App Store Connect
with the guideline number and a paragraph of explanation, and you can reply
to it there before changing anything. Reply first if you think the reviewer
missed something; resubmit only when something has actually changed.

### Guideline 4.2, minimum functionality ("this is a website in a wrapper")

The risk is real for any app built from a web codebase. What sHUttl has that
a website in Safari does not:

- push notifications through Apple's push service (a home-screen web page
  needs to be installed by hand before it can receive any);
- the interface ships inside the app and opens without the network;
- the system share sheet, the native location permission, haptics.

**First response:** reply, do not resubmit. Say that the interface is
bundled and not loaded from a URL, list the native features above, and point
to the demonstration video. Ask what specifically they found lacking.

**If that does not settle it:** the answer Apple wants is more that only an
app can do. The realistic additions, each a real piece of work, are a
home-screen widget or Live Activity showing the next departure, and
reminders that work without the Classes import. Do not try to argue past a
second 4.2 rejection without adding something.

### Guideline 5.2, intellectual property (the Harvard name, and the data)

Three things could draw this: the word "Harvard" in the subtitle, keywords
and description; the icon, whose letters "HU" are set in crimson; and the
shuttle data itself, which comes from Harvard's tracker. The app does not
use the shield, the word "Veritas", or "Harvard" in its name.

Work down this list and stop at the first step that gets it through:

1. **Reply explaining the use.** The name appears only to say which shuttle
   network the app covers, every mention is paired with a statement that the
   app is independent and unofficial, and no Harvard logo or insignia is
   used. Offer to change wording they object to.
2. **Remove the name from the listing.** Switch to the fallback subtitle and
   the keyword list without `harvard` in `APP_STORE_LISTING.md`, and say
   "the university's campus shuttles" in the promotional text. Keep the
   non-affiliation sentence.
3. **Get permission in writing.** If Apple asks for documentation that you
   may use the name or the data, the only thing that satisfies it is a
   message from the university. Harvard has its own policy on the use of its
   name, and Harvard Transportation runs the shuttle tracker; ask both, and
   attach the reply in the App Review notes. This is also the honest answer
   to the content-rights question in step 36, so it is worth asking before
   you submit at all, not only after a rejection.
4. **Change the icon.** If the crimson "HU" is named specifically, recolour
   the wordmark in `frontend/assets/icon-only.png`, run
   `npx capacitor-assets generate --ios` from `frontend/`, and rebuild.

### Anything else

The other rejections worth being ready for are all privacy. If the reviewer
cannot find the privacy policy in the app (guideline 5.1.1), point to the
"Privacy policy" link on the first-launch screen and at the end of Classes.
If they ask about data sent to a third-party AI service (guideline 5.1.2),
point to the question the app asks before the first screenshot is uploaded,
which names OpenAI and waits for Allow. The third is App Privacy answers
that do not match what the reviewer sees the app do. If the reviewer asks
why location or photos are requested, the answer is in the permission
sentences in `Info.plist` and in section 4 of the listing file.

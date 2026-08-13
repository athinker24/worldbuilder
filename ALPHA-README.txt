WORLDBUILDER - ALPHA NOTES
================================================================================

You're one of the first people outside this machine to run Worldbuilder.
Thank you for testing it. This page covers the handful of things worth
knowing before you start; everything else in the app should be self-
explanatory, and if it isn't, that itself is worth reporting.


1. THIS IS ALPHA
--------------------------------------------------------------------------------

Expect bugs. The save/data-safety side of the app has had real attention (see
TERMS.txt and PRIVACY.txt for the details), but that does not mean nothing
will go wrong — it means that when something does, the app should tell you
rather than fail silently. If it ever doesn't, that is the most useful kind
of report you can send.

The .world file format may still change between builds. A world you build
now should keep opening in later alpha builds, but this is not yet a promise
the way it will be at release.


2. INSTALLING
--------------------------------------------------------------------------------

Two files, both open the same app:

  Worldbuilder-Setup.exe    A normal installer. No admin rights needed.
  Worldbuilder-portable.zip Extract anywhere and run Worldbuilder.exe.

Running the .exe will very likely show a blue "Windows protected your PC"
screen. This is not a virus warning — it appears because the app is not
signed with a paid certificate, and Windows shows this for any unrecognised
publisher. Click "More info" then "Run anyway". Once per file is enough.


3. WHERE YOUR DATA LIVES
--------------------------------------------------------------------------------

Everything is saved instantly, on your own computer, here:

  Documents\Worldbuilder\
      world.db     your current world (a database)
      assets\      images you've added
      backups\     automatic dated copies
      logs\        session logs (see section 5)

No account, no cloud, no network requests at all — see PRIVACY.txt for the
full statement.


4. STARTING THE APP ALWAYS GIVES YOU A BLANK WORLD
--------------------------------------------------------------------------------

This is deliberate, not a bug: every launch opens on a fresh, empty world.
If the world you had open last time held anything, it was NOT deleted —
it was packed into a single file under backups\ automatically, and that file
shows up under "Recent" on the start screen the next time you open the app,
ready to reopen with one click.

To keep working on the SAME world across sessions instead of starting fresh
each time, save it once with Ctrl+S (or File > Save) and give it a name.
From then on, opening that file (from Recent, or by double-clicking the
.world file itself) picks up where you left off.

If you ever close the app and the world you expected is not on the start
screen's Recent list, check backups\ directly — every session that had
anything in it is in there, dated.


5. IF SOMETHING GOES WRONG
--------------------------------------------------------------------------------

Help > Open Error Log (or Preferences > Developer > Open Log Folder) opens
THIS session's log file, selected, ready to attach. It records what the app
did and when, including any error and where it happened — never the content
of your world, never your file paths, never your username (see PRIVACY.txt).

Send that file along with a short note on what you were doing when it
happened. The build version is shown in Preferences > Developer, next to
the log button — include it, since more than one build may be in testing
at once.


6. PRIVACY, SHORT VERSION
--------------------------------------------------------------------------------

Worldbuilder makes no network requests, has no account, no telemetry and no
update check. Nothing leaves your computer unless you send a file yourself.
Full statement: PRIVACY.txt (Help > Privacy Policy).

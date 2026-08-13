Worldbuilder - Alpha Notes
================================================================================

Thank you for testing Worldbuilder - you're one of the first people to try
it. This page covers the handful of things worth knowing before you start;
everything else in the app should be self-explanatory, and if it isn't,
that itself is worth reporting.


1. This is alpha
--------------------------------------------------------------------------------

Expect bugs. The save/data-safety side of the app has had real attention (see
TERMS.txt and PRIVACY.txt for the details), but that does not mean nothing
will go wrong. It means that when something does, the app should tell you
rather than fail silently. If it ever doesn't, that is the most useful kind
of report you can send.

The .world file format may still change between builds. A world you build
now should keep opening in later alpha builds, but this is not yet a promise
the way it will be at release.


2. Installing
--------------------------------------------------------------------------------

Two files, both open the same app:

  Worldbuilder-Setup.exe    A normal installer. No admin rights needed.
  Worldbuilder-portable.zip Extract anywhere and run Worldbuilder.exe.

Running the .exe will very likely show a blue "Windows protected your PC"
screen. This is not a virus warning. It appears because the app is not
signed with a paid certificate, and Windows shows this for any unrecognised
publisher. Click "More info" then "Run anyway". Once per file is enough.


3. Where your data lives
--------------------------------------------------------------------------------

Everything is saved instantly, on your own computer, here:

  Documents\Worldbuilder\
      world.db     your current world (a database)
      assets\      images you've added
      backups\     automatic dated copies
      logs\        session logs (see section 5)

No account, no cloud, no network requests at all. See PRIVACY.txt for the
full statement.


4. Starting the app always gives you a blank world
--------------------------------------------------------------------------------

This is deliberate, not a bug: every launch opens on a fresh, empty world.
If the world you had open last time held anything, it was not deleted -
it was packed into a single file under backups\ automatically, and that
shows up as "Previous session" on the start screen the next time you open
the app, ready to reopen with one click. That is separate from "Recent",
which is for worlds you saved and named yourself.

To keep working on the same world across sessions instead of starting fresh
each time, save it once with Ctrl+S (or File > Save) and give it a name.
From then on, opening that file (from Recent, or by double-clicking the
.world file itself) picks up where you left off.

If you ever close the app and don't see "Previous session" on the start
screen, check backups\ directly - every session that had anything in it is
in there, dated.


5. If something goes wrong
--------------------------------------------------------------------------------

Help > Open Error Log (or Preferences > Developer > Open Log Folder) opens
this session's log file, selected, ready to attach. It records what the app
did and when, including any error and where it happened, but never the
content of your world, your file paths, or your username (see PRIVACY.txt).

Send that file along with a short note on what you were doing when it
happened. The build version is shown in Preferences > Developer, next to
the log button - include it, since more than one build may be in testing
at once.


6. Privacy, short version
--------------------------------------------------------------------------------

Worldbuilder makes no network requests, has no account, no telemetry and no
update check. Nothing leaves your computer unless you send a file yourself.
Full statement: PRIVACY.txt (Help > Privacy Policy).

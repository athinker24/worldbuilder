DUNYA — Worldbuilding App
=========================

A personal worldbuilding desktop app: an interactive map, encyclopedia-style
articles, dynasties, languages, timelines — all linked together.

This is a hobby project shared for friends to try out. It is NOT a published
product, so a few rough edges below (like the security warning) are normal
and expected.


HOW TO DOWNLOAD AND RUN (Windows only)
---------------------------------------

1. Go to the "Releases" page of this GitHub repo (right-hand sidebar, or:
   https://github.com/<USERNAME>/<REPO>/releases ).

2. Download one of these two files from the latest release:

   - Dunya-portable.exe
     No installation. Just double-click and it runs. Good if you want to
     try it quickly or don't want anything added to your Start Menu.

   - Dunya-setup.exe
     A normal installer. Creates a desktop shortcut and Start Menu entry,
     and you can uninstall it later like any other app.

   Either one works the same once open — pick whichever you prefer.

3. Double-click the file you downloaded.


ABOUT THE "WINDOWS PROTECTED YOUR PC" WARNING
-----------------------------------------------

When you run the .exe, Windows SmartScreen will likely show a blue warning
screen saying "Windows protected your PC".

This is NOT a virus warning. It appears because the app isn't digitally
signed with a paid certificate (those cost money and this is a free hobby
project). Windows shows this for any unsigned app from an unrecognized
publisher, signed or not.

To continue:
   1. Click "More info" (small link on the warning screen).
   2. Click "Run anyway".

The app will then open normally. You only need to do this once per file.

If you're not comfortable running an unsigned .exe from a friend, that's a
completely reasonable choice — you can also build it yourself from source
(see "Building from source" below), which lets you inspect the code first.


WHERE YOUR DATA IS STORED
---------------------------

Everything you create (your map, articles, dynasties, etc.) is saved
automatically to:

   Documents\Dunya\

This folder contains:
   - world.db      — the actual database (all your content)
   - assets\       — images you add (banners, map backgrounds, etc.)
   - backups\      — automatic daily backups (kept for 30 days)

There is no cloud sync and no account — everything stays on your own
computer. To back up manually, just copy the whole "Dunya" folder somewhere
safe. To start completely fresh, close the app and delete/rename that
folder.


BASIC CONTROLS
----------------

   Ctrl+K              Quick jump / search palette
   Ctrl+Z / Ctrl+Y      Undo / redo
   Del / Backspace      Delete the selected item
   Alt+Left / Alt+Right Navigate back / forward
   Middle-click drag    Pan the map
   Right-click          Context menu (on the map, a drawing, or the sidebar)


BUILDING FROM SOURCE (optional, for the curious)
---------------------------------------------------

If you'd rather build it yourself instead of running a pre-built .exe:

   1. Install Node.js (v20 or newer): https://nodejs.org
   2. Download or clone this repository.
   3. Open a terminal in the project folder and run:

        npm install
        npm run build:win

   4. Your own .exe will appear in the "dist" folder.

   To just try it without building an installer:

        npm install
        npm run dev


QUESTIONS OR PROBLEMS
------------------------

This is a work-in-progress hobby project — things may be unfinished or
change over time. If something breaks or looks wrong, just ask the person
who shared this with you.

# Nextion HMI Tool (`nextion-hmi-tool`)

> **Lossless, bi-directional human-readable YAML layout, script, font & asset manager for Nextion `.HMI` project files with zero external dependencies.**

Nextion Editor stores its UI projects in proprietary compound binary files (`.HMI`). Modifying layout coordinates, colors, fonts, or component logic in bulk using the Nextion GUI is tedious and error-prone. Furthermore, Nextion `.HMI` files are locked with multiple layers of proprietary IEEE 802.3 CRCs and checksums—meaning naive edits or third-party tools result in Nextion Editor reporting:
> `"Wrong Hmifile or Hmifile has been damaged."`

**`nextion-hmi-tool`** completely solves this problem. It allows you to **export** any Nextion `.HMI` project into clean per-page YAML files, standard PNG images, `.zi` font files, and syntax-highlighted script files, edit or add logic, components, pictures, and fonts in your favorite IDE, and **import** them back into a valid `.HMI` file that Nextion Editor opens and compiles seamlessly.

---

## Features

- **Zero Dependencies**: Pure Node.js (uses only built-in `fs`, `path`, `zlib`, and `crypto`).
- **Clean Folder Structure**:
  - `pages/<page>.yaml`: One YAML file per page.
  - `scripts/<page>/`: Modular script files with IDE syntax highlighting (`.js` extension with Nextion instruction set header).
  - `pictures/`: Standard PNG files extracted from the project.
  - `pictures.yaml`: Human-readable picture definitions and sequential IDs.
  - `fonts/`: Extracted `.zi` binary font files.
  - `fonts.yaml`: Font ID mapping, file names, and byte sizes.
  - `project.json`: Manifest preserving binary offsets, component maps, and cryptographic hashes.
- **Bi-directional Editing**:
  - **Modify existing components**: change `x`, `y`, `w`, `h`, `txt`, `font`, `pco` (foreground), `bco` (background), `xcen`, `ycen`, `pic`, `picc`.
  - **Script logic**: edit event scripts in separate files or inline in YAML (`codesdown`, `codesup`, `codestimer`, `codesload`, etc.).
  - **Variables**: declare and configure numeric or string variables (`type: "variable"`, `vscope: "local"|"global"`, `var_type: "number"|"string"`, `val`, `txt`, `txt_maxl`).
  - **Timers**: configure timer intervals and tick logic (`type: "timer"`, `tim`, `en`, `codestimer`).
  - **Add new components**: inject new `button`, `text`, `picture`, `hotspot`, `variable`, or `timer` elements directly in YAML.
  - **Add or replace pictures**: drop any PNG into `pictures/` and list it in `pictures.yaml`—automatically converted to Nextion's native Mode 0 RGB565 format.
  - **Add or replace fonts**: replace any `.zi` file in `fonts/` or append new fonts to `fonts.yaml`.
- **Integrity & Safety Protections**:
  - **Picture Order & Sequence Protection**: prevents scrambled picture IDs caused by accidental deletion or reordering.
  - **Font Order & Sequence Protection**: prevents corrupted font references.
  - **Component Removal Protection**: prevents accidental component deletion that would break contiguous Nextion IDs and internal scripts.
- **Minimal, Surgical Changes**: Unchanged pictures, fonts, and components remain 100% untouched and byte-identical.
- **Non-Destructive**: Never overwrites the source `.HMI` file; always outputs a new `.HMI` file.
- **Full Nextion CRC Engine**: Automatically recalculates:
  - Page `.pa` CRCs
  - Archive Directory Table `ADEC` CRC (at `0x00000` and mirrored at `0x80000`)
  - Internal `main.HMI` 4-stage IEEE 802.3 CRC

---

## Installation

Requires [Node.js](https://nodejs.org/) (v14 or later). No `npm install` needed!

```bash
git clone https://github.com/leo212/nextion-hmi-tool.git
cd nextion-hmi-tool
```

---

## Quick Start

### 1. Export an HMI Project

```bash
node hmi_tool.js export <path/to/project.HMI> [output_directory]
```

If `output_directory` is omitted, it creates a folder named after the HMI file (e.g. `nspanel_home/`).

#### Exported Structure:
```text
nspanel_home/
├── pages/
│   └── home.yaml               # Components, layout & variable definitions
├── scripts/
│   └── home/
│       ├── fn_center_ac.codesdown.js   # Touch-press event script
│       └── click_timer.codestimer.js   # Timer event script
├── pictures/
│   ├── 0.png                   # Extracted PNG assets
│   ├── 1.png
│   └── ...
├── pictures.yaml               # Picture ID mapping
├── fonts/
│   ├── 0.zi                    # Extracted font files
│   └── ...
├── fonts.yaml                  # Font ID mapping
└── project.json                # Project manifest with hashes & component maps
```

---

### 2. Editing UI & Components in YAML

Open `pages/home.yaml` in any text editor. You can move components, change fonts, colors, text, or define variables:

```yaml
page: "home"
components:
  - objname: "t_time"
    type: "text"
    x: 10
    y: 15
    w: 120
    h: 30
    txt: "12:00"
    font: 2
    pco: 65535 # White
    bco: 0     # Black

  # Hotspot running logic from a script file
  - objname: "fn_center_ac"
    type: "hotspot"
    x: 0
    y: 0
    w: 2
    h: 2
    scripts:
      codesdown: "scripts/home/fn_center_ac.codesdown.js"

  # Numeric Variable (local scope)
  - objname: "va_calc"
    type: "variable"
    vscope: "local"
    var_type: "number"
    val: 0

  # String Variable
  - objname: "cmd_in"
    type: "variable"
    vscope: "local"
    var_type: "string"
    txt: "init"
    txt_maxl: 30

  # Timer Component (800ms)
  - objname: "click_timer"
    type: "timer"
    vscope: "local"
    tim: 800
    en: 0
    scripts:
      codestimer: "scripts/home/click_timer.codestimer.js"
```

#### Adding New Components:
Simply append a new item to `components` in the YAML file:
* **Buttons**: `type: "button"`
* **Text**: `type: "text"`
* **Pictures**: `type: "picture"`, `pic: <id>`
* **Hotspots**: `type: "hotspot"`
* **Variables**: `type: "variable"`, `var_type: "number"|"string"`, `vscope: "local"|"global"`
* **Timers**: `type: "timer"`, `tim: <ms>`, `en: 0|1`

---

### 3. Writing Nextion Scripts

Scripts are exported into `scripts/<page>/<component>.<event>.js` with automatic JavaScript syntax highlighting in modern IDEs.

Every script file starts with a clear header comment:
```javascript
// Nextion Display Script (Nextion instruction set syntax, not standard JavaScript)
spstr cmd_in.txt,va_pwr.txt,",",0
if(va_calc.val<=245)
{
  va_color.val=2047
}
p_gauge.pic=va_dec_num.val
ref t_ac_pwr
```

#### Supported Event Keys (with friendly aliases):
| Nextion Event Record | Friendly YAML Alias | Description |
|---|---|---|
| `codesdown` | `touch_press` | Touch Press Event |
| `codesup` | `touch_release` | Touch Release Event |
| `codestimer` | `timer` | Timer Tick Event |
| `codesload` | `pre_init` | Page Pre-Initialization Event |
| `codesloadend` | `post_init` | Page Post-Initialization Event |
| `codesunload` | `page_exit` | Page Exit / Leave Event |

*You can also define short scripts inline in YAML using multiline `|`:*
```yaml
  - objname: "b_next"
    type: "button"
    x: 10
    y: 10
    w: 80
    h: 40
    scripts:
      codesdown: |
        page page1
```

---

### 4. Pictures & Fonts Management

#### Replacing Pictures or Fonts:
* **Pictures**: Replace the PNG file in `pictures/<id>.png`. The tool compares SHA-256 hashes during import and only re-encodes changed images.
* **Fonts**: Replace the `.zi` file in `fonts/<id>.zi`. The tool detects the changed hash and updates the archive entry.

#### Adding New Pictures or Fonts:
* **New Picture**: Place a new PNG in `pictures/` and append it sequentially to `pictures.yaml`.
* **New Font**: Place a new `.zi` file in `fonts/` and append it sequentially to `fonts.yaml`.

#### Safety Protections:
To protect against corrupted project files and broken UI bindings:
1. **Picture & Font IDs must be strictly sequential** (`0, 1, 2, ...`).
2. **Deleting or reordering original pictures/fonts is blocked** to prevent shifting indices and scrambling references (`pic`, `picc`, `font`) across pages.
3. **Omitting existing page components from YAML is blocked** to prevent breaking contiguous component IDs.

---

### 5. Import Back into HMI

Compile your changes into a brand new Nextion `.HMI` file:

```bash
node hmi_tool.js import <project_directory> [output.HMI]
```

If `output.HMI` is omitted, it creates `<source_name>_modified.HMI`.

Now open the newly generated file in **Nextion Editor** or flash it to your device!

---

## Known Limitations

1. **No Component Deletion**: Removing components by deleting them from a page YAML is intentionally unsupported. In Nextion, component IDs are strictly contiguous; removing an item requires re-indexing all subsequent IDs and risks breaking Nextion scripts that reference components by ID or name.
2. **No Picture or Font Deletion / Reordering**: You cannot delete or change the order of existing pictures or fonts. In Nextion, components store hardcoded integer indices for picture and font bindings (`pic`, `picc`, `font`); shifting or deleting existing entries causes references to point to incorrect assets. You may, however, replace asset files in place or append new assets sequentially.
3. **Page Creation**: Adding entirely new pages from scratch without an existing page template is not currently supported. Create your base pages in Nextion Editor first, then manage all components, scripts, layouts, and assets using this tool.
4. **Complex Custom Widgets**: Dynamic component injection supports standard Nextion types (`button`, `text`, `picture`, `hotspot`, `variable`, `timer`). Highly specialized or complex widgets (e.g. waveform, custom canvas, dual-state buttons) should be initially placed via Nextion Editor before editing properties in YAML.

---

## Disclaimer & Limitation of Liability

> [!WARNING]
> **Use at your own risk.** This tool is an independent, community-developed reverse-engineering project and is **not** affiliated with, endorsed by, or supported by ITEAD Studio, Nextion, or their affiliates.

* **Always keep backups**: Always maintain verified backup copies of your original `.HMI` project files before using this tool.
* **No Warranty**: This software is provided "AS IS", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.
* **Limitation of Liability**: In no event shall the authors or copyright holders be liable for any claim, damages, data loss, project corruption, hardware malfunction, or other liability arising from the use or inability to use this software or files generated by it.
* **Editor Verification**: Always verify generated `.HMI` files by opening and compiling them in Nextion Editor prior to flashing to production hardware.

---

## Technical Specifications & Reverse Engineering Notes

### Compound Archive Layout
Nextion `.HMI` projects are FAT-like compound archives:
- **`0x00000`**: Primary Directory Table (28 bytes per entry) followed by an `ADEC`-keyed IEEE 802.3 CRC.
- **`0x80000`** (512 KB): Mirrored backup Directory Table and CRC.
- **`0x700000`** (7 MB): Start of internal file stream (`main.HMI`, `Program.s`, `*.pa` pages, `*.i` device bitmaps, `*.is` source PNGs, `*.zi` fonts).

### Device Bitmap Format (`*.i`)
Nextion devices render images from compiled bitmaps:
- **Header (24 bytes)**: Magic `0x0a640103` (or `0x0b640103`), uint16 width at `0x0c`, uint16 height at `0x0e`, uint32 data size at `0x10`.
- **Mode 0 (Raw Uncompressed RGB565)**: 20 zero bytes followed by `width * height * 2` bytes of 16-bit little-endian RGB565 pixels.

### The `main.HMI` CRC Formula
Nextion Editor validates the project header using a 4-pass IEEE 802.3 CRC over specific fields:
```javascript
function computeNextionMainHmiCrc(mainHmiBuf) {
    let c = nextionCrcUpdate(0xffffffff, mainHmiBuf.subarray(4));
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(16, 20)); // offset 0x10, len 4
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(4, 8));   // offset 0x04, len 4
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(10, 11)); // offset 0x0a, len 1
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(14, 15)); // offset 0x0e, len 1
    return c >>> 0;
}
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

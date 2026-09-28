# Nextion HMI Tool (`nextion-hmi-tool`)

> **Lossless, bi-directional human-readable YAML layout & asset manager for Nextion `.HMI` project files with zero external dependencies.**

Nextion Editor stores its UI projects in proprietary compound binary files (`.HMI`). Modifying layout coordinates, colors, fonts, or component positions in bulk using the Nextion GUI is tedious and error-prone. Furthermore, Nextion `.HMI` files are locked with multiple layers of proprietary IEEE 802.3 CRCs and checksums—meaning naive edits or third-party tools result in Nextion Editor reporting:
> `"Wrong Hmifile or Hmifile has been damaged."`

**`nextion-hmi-tool`** completely solves this problem. It allows you to **export** any Nextion `.HMI` project into clean per-page YAML files and standard PNG images, edit or add components and pictures in your favorite text editor / image editor, and **import** them back into a valid `.HMI` file that Nextion Editor opens and compiles seamlessly.

---

## Features

- **Zero Dependencies**: Pure Node.js (uses only built-in `fs`, `path`, `zlib`, and `crypto`).
- **Clean Folder Structure**:
  - `pages/<page>.yaml`: One YAML file per page.
  - `pictures/`: Standard PNG files extracted from the project.
  - `pictures.yaml`: Human-readable picture definitions and IDs.
  - `project.json`: Manifest preserving binary offsets and cryptographic hashes.
- **Bi-directional Editing**:
  - **Modify existing components**: change `x`, `y`, `w`, `h`, `txt`, `font`, `pco` (foreground), `bco` (background), `xcen`, `ycen`, `pic`, `picc`.
  - **Add new components**: inject new `button`, `text`, `picture`, or `hotspot` elements directly in YAML.
  - **Add new pictures**: drop any PNG into `pictures/` and list it in `pictures.yaml`—it will be automatically converted to Nextion's native Mode 0 RGB565 format and registered with a sequential Picture ID.
  - **Replace existing pictures**: modify any PNG in `pictures/` and the tool will detect the modification via SHA-256 and recompile it.
- **Minimal, Surgical Changes**: Unchanged pictures and components remain 100% untouched and byte-identical.
- **Non-Destructive**: Never overwrites the source `.HMI` file; always outputs a new `.HMI` file.
- **Full Nextion CRC Engine**: Automatically recalculates:
  - Page `.pa` CRCs
  - Archive Directory Table `ADEC` CRC (at `0x00000` and mirrored at `0x80000`)
  - Internal `main.HMI` 4-stage IEEE 802.3 CRC

---

## Installation

Requires [Node.js](https://nodejs.org/) (v14 or later). No `npm install` needed!

```bash
git clone https://github.com/<your-username>/nextion-hmi-tool.git
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
+-- pages/
¦   +-- home.yaml          # Components and visual layout for each page
+-- pictures/
¦   +-- 0.png              # Extracted PNG assets
¦   +-- 1.png
¦   +-- ...
+-- pictures.yaml          # Picture ID mapping
+-- project.json           # Manifest with original offsets & hashes
```

---

### 2. Edit Components in YAML

Open `pages/home.yaml` in any text editor. You can move components, change fonts, colors, or text:

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
```

#### Adding a New Component:
Simply append a new item to the `components` list in your page YAML:

```yaml
  # Add a new button
  - objname: "b_restart"
    type: "button"
    x: 100
    y: 200
    w: 80
    h: 40
    txt: "Restart"
    font: 1
    pco: 65535
    bco: 1024

  # Add a new picture displaying Picture ID 82
  - objname: "p_logo"
    type: "picture"
    x: 200
    y: 50
    w: 64
    h: 64
    pic: 82
```

Supported `type` values: `text`, `button`, `picture`, `hotspot`.

---

### 3. Replace or Add Pictures

#### Replacing an Existing Picture:
Simply replace the PNG file in `pictures/<id>.png` with your new image. The tool compares SHA-256 hashes during import and re-encodes only the changed image.

#### Adding a New Picture:
1. Drop your new PNG file into `pictures/` (e.g. `pictures/82.png`).
2. Add an entry to `pictures.yaml`:

```yaml
pictures:
  - id: 0
    name: "54.i"
    file: "0.png"
    width: 480
    height: 320
  ...
  # New picture:
  - id: 82
    file: "82.png"
    width: 64
    height: 64
```

> **Note on Picture IDs**: Nextion assigns sequential 0-based IDs (`0, 1, 2, ...`). The tool strictly appends new pictures at the end of the registry so all existing component picture references (`pic`, `picc`) remain 100% valid.

---

### 4. Import Back into HMI

Compile your changes into a brand new Nextion `.HMI` file:

```bash
node hmi_tool.js import <project_directory> [output.HMI]
```

If `output.HMI` is omitted, it creates `<source_name>_modified.HMI`.

Now open the newly generated file in **Nextion Editor** or compile it directly for your device!

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

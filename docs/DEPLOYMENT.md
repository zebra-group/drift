# Deployment

## Überblick

drift besteht aus drei pnpm-Workspace-Paketen (`core`, `cli`, `desktop`). Nur `desktop` wird als
eigenständiges Artefakt ausgeliefert — als Electron-Desktop-App über **GitHub Releases**
(`zebra-group/drift`). `core` und `cli` werden aktuell nicht separat veröffentlicht (kein npm-Publish).

- **Hosting/Vertrieb**: GitHub Releases (öffentliches Repo `zebra-group/drift`), keine eigene
  Update-Infrastruktur.
- **Build**: GitHub Actions (`.github/workflows/release.yml`), Matrix-Build auf
  `macos-latest` / `windows-latest` / `ubuntu-22.04`.
- **Packaging**: `electron-builder` (Config: `packages/desktop/electron-builder.yml`).
- **Auto-Update im Client**: `electron-updater` (`packages/desktop/src/main/updater.ts`), Provider
  `github`, prüft alle 5 Minuten sowie 3 Sekunden nach Start.

## Build-Prozess

```bash
pnpm install
pnpm --filter @db-mirror/core build
pnpm --filter @db-mirror/desktop build   # tsc (main) + vite (renderer)
pnpm --filter @db-mirror/desktop package # electron-builder -> packages/desktop/release/
```

Artefakte pro Plattform (siehe `electron-builder.yml`):

| Plattform | Artefakte |
|---|---|
| macOS | `.dmg` (arm64 + x64), `.zip` (Update-Payload für electron-updater) |
| Windows | NSIS `.exe` |
| Linux | `.AppImage`, `.deb` |

Zusätzlich erzeugt electron-builder `latest.yml` / `latest-mac.yml` / `latest-linux.yml` —
das sind die Feed-Dateien, gegen die `electron-updater` im Client die installierte Version
abgleicht.

## Deployment-Ablauf (CI/CD)

Trigger: Push eines Tags `vX.Y.Z` auf `main`.

1. **Build-Job** (pro OS): Version aus dem Tag in alle `package.json` einsynchronisieren →
   Dependencies installieren → `core` und `desktop` bauen → `electron-builder` packagen →
   Artefakte als Workflow-Artifact hochladen.
2. **Release-Job**: vorhandenen Draft-Release (von electron-builder via `publish.provider: github`
   erzeugt) finalisieren (`gh release edit --draft=false`) mit generierten Installationshinweisen.

Manuelles Release: `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Benötigte Umgebungsvariablen/Secrets

| Variable | Zweck | Wo konfiguriert |
|---|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | Release-Upload & Finalisierung | GitHub Actions (`secrets.GITHUB_TOKEN`, automatisch) |
| `CSC_IDENTITY_AUTO_DISCOVERY=false` | verhindert, dass electron-builder auf dem macOS-Runner nach einem lokalen Signing-Zertifikat sucht | im Workflow-Step `Package` gesetzt |

**Es sind aktuell keine Code-Signing- oder Notarisierungs-Zertifikate hinterlegt.** Die macOS-App
wird unsigniert ausgeliefert (`mac.identity: null`, `hardenedRuntime: false`); Nutzer müssen den
Quarantäne-Flag manuell entfernen bzw. die App ad-hoc neu signieren (siehe Troubleshooting).
Für Windows existiert ebenfalls kein Signing-Zertifikat.

## Troubleshooting

- **macOS: „App ist beschädigt“ / Gatekeeper blockiert den Start**
  Erwartet, da unsigniert. Workaround (siehe auch Release-Notes-Template in `release.yml`):
  ```bash
  xattr -rd com.apple.quarantine /Applications/Drift.app
  # falls das nicht reicht:
  sudo codesign --force --deep --sign - /Applications/Drift.app
  ```
- **Release-Build schlägt auf einem OS fehl, andere laufen durch**: `fail-fast: false` in der
  Matrix-Strategie ist bewusst so gesetzt — einzelne Plattform-Fehler blockieren die anderen nicht.
- **Auto-Update kommt bei Clients nicht an**: `latest*.yml` muss im (finalisierten, nicht-draft)
  Release liegen; ein Draft-Release wird von `electron-updater` nicht gefunden.

---

## appId-Migration `de.mindbox.drift` → `de.zebra.drift`

Kontext: [ClickUp #124hv5uu4wj](https://app.clickup.com/t/124hv5uu4wj). Entscheidung (2026-09-21):
appId wird geändert, mit koordiniertem Rollout. **Status: appId im Code bereits auf
`de.zebra.drift` umgestellt (`electron-builder.yml`); Rollout/Kommunikation an Nutzer steht
noch aus.**

### Ausgangslage (verifiziert)

- `appId` stand nur in `electron-builder.yml`, wird sonst nirgends im Code referenziert
  (kein `app.setName`, kein appId-Vergleich zur Laufzeit).
- **14 reale Releases** existieren bereits (v0.1.0–v0.1.14, April–Juni 2026) mit aktiven,
  Auto-Update-fähigen Installationen.
- **Kein bestehendes Signing-Zertifikat** (siehe oben) — der im Ticket beschriebene Punkt
  „neues Zertifikat auf zebra white GmbH ziehen" ist kein Migrations-, sondern ein optionales
  Verbesserungsthema und wird **nicht** als Blocker für die appId-Migration behandelt.
- **User-Data-Pfad hängt NICHT an der appId — empirisch verifiziert.** Am realen v0.1.14-macOS-
  Bundle geprüft: Electron liest den Namen für `app.getPath('userData')` aus dem gepackten
  `package.json`-Feld `"name"` (`@db-mirror/desktop`), das `electron-builder` unverändert
  durchreicht. Auf diesem Rechner existiert entsprechend bereits
  `~/Library/Application Support/@db-mirror/desktop`. **Solange `package.json`s `name`-Feld
  nicht angefasst wird, bleiben Vault, Connections und Settings bei einem reinen appId-Wechsel
  automatisch erhalten — keine eigene Migrationslogik nötig.** Wichtig: dieses `name`-Feld darf
  im Rahmen dieser Migration **nicht** geändert werden.
- **Risiko-Asymmetrie zwischen Plattformen bleibt bestehen** (appId-Wechsel selbst, unabhängig
  von User-Data):
  - *Windows (NSIS)*: appId steuert den Registry-Uninstall-Key (GUID) und den
    electron-updater-internen Update-State. Ein appId-Wechsel lässt den bestehenden
    Uninstall-Eintrag ggf. verwaist zurück, auch wenn der Installationspfad (basiert auf
    `productName` „Drift") gleich bleibt — **vor dem Rollout auf einem Windows-Testclient
    verifizieren**, ob die alte Registry-Eintragung sauber überschrieben oder doppelt angelegt wird.
  - *macOS*: `electron-updater`s `MacUpdater` ersetzt das `.app`-Bundle direkt über einen
    Zip-Download: unabhängig von userData, aber im unsignierten Zustand nicht
    production-verifiziert — **vor dem Rollout auf einem Test-Client verifizieren**.
  - *Linux*: kein Auto-Update-Mechanismus über AppImage/deb hinaus relevant, appId spielt hier
    kaum eine Rolle.

### Migrationsschritte

1. ~~appId-Wechsel im Code~~ **erledigt** (`electron-builder.yml`: `appId: de.zebra.drift`).
   `package.json` (`name: @db-mirror/desktop`) bewusst unverändert gelassen (siehe oben).

2. **Vor dem Cutoff-Release: Testclient-Verifikation**
   - Auf je einem Windows- und macOS-Testgerät die bestehende v0.1.14 installieren, dann eine
     lokal gebaute Version mit der neuen appId als „Update" andocken und beobachten:
     Uninstall-Eintrag (Windows), sauberer In-Place-Replace (macOS).

3. **Bridge-Release unter alter appId**
   - Letzte Version mit `de.mindbox.drift` ausliefern, die aktiv auf den Cutoff hinweist
     (In-App-Banner: „Am [Datum] folgt eine einmalige Neuinstallation/Update, danach automatisch
     wie gewohnt"). Noch zu implementieren (Renderer-Banner-Komponente), nicht Teil dieser Änderung.
   - Kein reines Warten auf organisches Update-Verhalten — Cutoff-Datum fix kommunizieren
     (Empfehlung: 4–6 Wochen Vorlauf).

4. **CI/CD-Anpassung für den Cutoff-Release**
   - `release.yml` / Release-Notes-Template: Hinweis auf die appId-Umstellung ergänzen.
   - Windows: falls Schritt 2 einen verwaisten Uninstall-Eintrag bestätigt, Deinstallations-Hinweis
     für die alte Installation in die Release-Notes aufnehmen.

5. **Kommunikation an bestehende Nutzer**
   - Ankündigung (Teams/E-Mail) mit Datum, Grund (Rebranding), und was Nutzer ggf. manuell tun
     müssen.

6. **Rollout**
   - Canary: intern zuerst (Ops-Team) auf allen 3 Plattformen testen.
   - Danach reguläres Release über den bestehenden CI/CD-Weg (Tag-Push).

7. **Nachbereitung**
   - Diesen Abschnitt nach Abschluss der Migration archivieren/entfernen.

### Offene Punkte / Risiken

- Tatsächliche Nutzeranzahl/-verteilung unbekannt (keine Telemetrie) — beeinflusst, wie kritisch
  der Cutoff-Zeitpunkt kommuniziert werden muss.
- Windows-Uninstall-Registry- und macOS-Update-Verhalten bei appId-Wechsel im unsignierten
  Zustand noch nicht production-verifiziert (Schritt 2).
- In-App-Cutoff-Banner (Schritt 3) noch nicht implementiert.
- Code-Signing/Notarisierung bewusst **nicht** Teil dieser Migration — falls gewünscht, separates
  Ticket.

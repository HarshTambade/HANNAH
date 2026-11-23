import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const kotlinBuildscript = `buildscript {
    ext.kotlin_version = project.hasProperty("kotlin_version") ? rootProject.ext.kotlin_version : "2.2.20"
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"
    }
}

`;

const moduleGradleFiles = [
  "node_modules/@elizaos/capacitor-talkmode/android/build.gradle",
  "node_modules/@pinecall/ionic/android/build.gradle",
  "node_modules/capacitor-lancedb/android/build.gradle",
  "node_modules/capacitor-mobile-claw/android/build.gradle",
  "node_modules/capacitor-mobilecron/android/build.gradle",
  "node_modules/capacitor-native-agent/android/build.gradle",
];

const kotlinClasspathPattern = /\s*classpath\s+["']org\.jetbrains\.kotlin:kotlin-gradle-plugin:[^"']+["']\s*\n?/g;
const kotlinOnlyBuildscriptPattern = /^buildscript\s*\{[\s\S]*?\n\}\n\n(?=apply plugin:)/;

for (const relativePath of moduleGradleFiles) {
  const filePath = resolve(projectRoot, relativePath);
  if (!existsSync(filePath)) continue;

  const source = readFileSync(filePath, "utf8");
  let patchedSource = source;

  patchedSource = patchedSource.replace(kotlinClasspathPattern, "");

  if (
    relativePath === "node_modules/capacitor-lancedb/android/build.gradle" ||
    relativePath === "node_modules/capacitor-mobile-claw/android/build.gradle" ||
    relativePath === "node_modules/capacitor-mobilecron/android/build.gradle" ||
    relativePath === "node_modules/capacitor-native-agent/android/build.gradle" ||
    relativePath === "node_modules/@elizaos/capacitor-talkmode/android/build.gradle"
  ) {
    patchedSource = patchedSource.replace(kotlinOnlyBuildscriptPattern, "");
  }

  if (
    /apply plugin:\s*['"](?:kotlin-android|org\.jetbrains\.kotlin\.android)['"]/.test(patchedSource) &&
    !patchedSource.includes("buildscript {")
  ) {
    patchedSource = `${kotlinBuildscript}${patchedSource}`;
  }

  if (
    relativePath === "node_modules/@pinecall/ionic/android/build.gradle" &&
    patchedSource.includes("compileOptions {") &&
    !patchedSource.includes("jvmTarget = '17'")
  ) {
    const repositoriesMarker = "\n}\n\nrepositories";
    if (!patchedSource.includes(repositoriesMarker)) {
      throw new Error(`Could not find Android configuration boundary in ${relativePath}`);
    }
    patchedSource = patchedSource.replace(
      repositoriesMarker,
      `\n\n    kotlinOptions {\n        jvmTarget = '17'\n    }${repositoriesMarker}`,
    );
  }

  if (patchedSource !== source) {
    writeFileSync(filePath, patchedSource);
    console.log(`Patched Android Gradle compatibility: ${relativePath}`);
  }
}

const manifestPath = resolve(projectRoot, "android/app/src/main/AndroidManifest.xml");
if (existsSync(manifestPath)) {
  let manifest = readFileSync(manifestPath, "utf8");
  if (!manifest.includes("android.permission.RECORD_AUDIO")) {
    const applicationTag = manifest.indexOf("<application");
    if (applicationTag < 0) throw new Error("Could not find the Android application tag in AndroidManifest.xml.");
    manifest = `${manifest.slice(0, applicationTag)}    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    ${manifest.slice(applicationTag)}`;
    writeFileSync(manifestPath, manifest);
    console.log("Added RECORD_AUDIO to the Android app manifest.");
  }
}

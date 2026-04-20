const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const platform = process.env.CAPACITOR_PLATFORM_NAME;
console.log("\tCloud Messaging plugin - running hook after update - for " + platform);
const projectDirPath = process.env.CAPACITOR_ROOT_DIR;
const webDirPath = process.env.CAPACITOR_WEB_DIR;

if (platform == 'android') {
    fixAndroidKaptGradleCapacitor();
    fixAndroidAzureRepository();
    const androidResDir = path.resolve(projectDirPath, 'android', 'app', 'src', 'main', 'res', 'raw');
    copySounds(androidResDir, webDirPath, platform);
} else if (platform == 'ios') {
    const iosResDir = path.resolve(projectDirPath, 'ios', 'App', 'App', 'public');
    const iosAppDelegateDir = path.resolve(projectDirPath, 'ios', 'App', 'App', 'AppDelegate.swift');
    const iosCapacitorConfig = path.resolve(projectDirPath, 'ios', 'App', 'App', 'capacitor.config.json');
    updateCapacitorConfig(iosCapacitorConfig);
    copySounds(iosResDir, webDirPath, platform);
    updateAppDelegate(iosAppDelegateDir);
    addNotificationServiceExtension();
}

function fixAndroidKaptGradleCapacitor() {
    const gradleFilePath = path.resolve(projectDirPath, 'android/app/build.gradle');
    const kaptPluginLong = 'org.jetbrains.kotlin.kapt';
    const kaptPluginShort = 'kotlin-kapt';
    const linesToPrepend = `
// region Kapt Plugin
// The lines inside this region were added via the Firebase Cloud Messaging Plugin to ensure kapt works in a Capacitor app.
apply plugin: 'kotlin-android'
apply plugin: 'kotlin-kapt'
// endregion
`.trimStart();

    let gradleContent = fs.readFileSync(gradleFilePath, 'utf8');

    if (gradleContent.includes(kaptPluginLong) || gradleContent.includes(kaptPluginShort)) {
        console.log('\t[SKIPPED] Kotlin Gradle plugin already defined. Skipping update.');
    } else {
        const updatedContent = `${linesToPrepend}\n${gradleContent}`;
        fs.writeFileSync(gradleFilePath, updatedContent, 'utf8');
        console.log('\t[SUCCESS] Prepended Kotlin Kapt plugin to build.gradle');
    }
}

function fixAndroidAzureRepository() {
    const gradleFilePath = path.resolve(projectDirPath, 'android/build.gradle');
    const azureUrl = 'https://pkgs.dev.azure.com/OutSystemsRD/9e79bc5b-69b2-4476-9ca5-d67594972a52/_packaging/PublicArtifactRepository/maven/v1';
    const mavenBlock = `        maven {
            url "${azureUrl}"
        }`;

    let gradleContent = fs.readFileSync(gradleFilePath, 'utf8');

    if (gradleContent.includes(azureUrl)) {
        console.log('\t[SKIPPED] Azure repository already in root build.gradle.');
    } else {
        const allprojectsStart = gradleContent.indexOf('allprojects {');
        if (allprojectsStart === -1) {
            console.warn('\t[WARNING] Could not find allprojects { ... } block. Unable to add Azure Repository');
            return;
        }
        const repositoriesStart = gradleContent.indexOf('repositories {', allprojectsStart);
        if (repositoriesStart === -1) {
            console.warn('\t[WARNING] Could not find allprojects { repositories { ... } } block. Unable to add Azure Repository');
            return;
        }
        // Track braces to find end of repositories block
        let braceCount = 0;
        let i = repositoriesStart + 'repositories {'.length - 1;
        let endIndex = -1;
        while (i < gradleContent.length) {
            if (gradleContent[i] === '{') braceCount++;
            else if (gradleContent[i] === '}') braceCount--;

            if (braceCount === 0) {
                endIndex = i;
                break;
            }
            i++;
        }
        if (endIndex === -1) {
            console.warn('\t[WARNING] Could not find allprojects { repositories { ... } } block. Unable to add Azure Repository');
            return;
        }
        const closingBraceLineStartIndex = gradleContent.lastIndexOf('\n', endIndex);
        // Insert the maven block at the end of the repositories block (before closing brace), because gradle searches repositories by order.
        // The Azure repo should be the last one since it will only apply for a few dependencies.
        // Otherwise this could slow down gradle build.
        const updatedContent = gradleContent.slice(0, closingBraceLineStartIndex) + '\n' + mavenBlock + gradleContent.slice(closingBraceLineStartIndex);
        fs.writeFileSync(gradleFilePath, updatedContent, 'utf8');
        console.log('\t[SUCCESS] Added Azure repository maven block to the root build.gradle.');
    }
}

function updateCapacitorConfig(configPath) {
    // read the existing config json
    let config = {};
    try {
        const fileContent = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(fileContent);
    } catch (e) {
        console.error('\t[ERROR] - Invalid JSON reading and parse - ' + e);
        process.exit(1);
    }
    // merge the new content with the existing json
    const newConfig = {
        ios: {
            handleApplicationNotifications: false
        }
    };
    config.ios = {
        ...config.ios,
        ...newConfig.ios
    };
    // Write back to config.json
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    console.log('\t[SUCCESS] capacitor.config.json updated successfully.');
}

function copySounds(nativeResourceDirectory, zipDirectory, platform) {
    let zipFilePath = path.resolve(zipDirectory, 'sounds.zip');
    if (!fs.existsSync(zipFilePath)) {
        // in some contexts (like ODC), a hash may be appended to the file name
        //  so we'll try searching for a sounds*.zip file
        const foundZipFile = fs.readdirSync(zipDirectory).find(f => f.toLowerCase().startsWith('sounds') && f.toLowerCase().endsWith('.zip'));
        if (!foundZipFile) {
            console.error('\t[SKIPPED] sounds.zip does not seem to exist. Skipping this action');
            return
        }
        zipFilePath = path.resolve(zipDirectory, foundZipFile);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-'));
    // Extract zip file to temporary directory (deleted at the end of the function)
    try {
        execSync(`unzip -qq "${zipFilePath}" -d "${tmpDir}"`);
    } catch (err) {
        console.error('\t[ERROR] Failed to unzip file:', err.message);
        process.exit(1);
    }

    const wavFiles = fs.readdirSync(tmpDir).filter(f => f.toLowerCase().endsWith('.wav'));
    if (wavFiles.length === 0) {
        console.warn('\t[SKIPPED] No .wav files found in zip, finishing.');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return
    }

    // Create target directories if needed
    if (!fs.existsSync(nativeResourceDirectory)) {
        fs.mkdirSync(nativeResourceDirectory, { recursive: true });
    }

    wavFiles.forEach(file => {
        const src = path.join(tmpDir, file);
        const dest = path.join(nativeResourceDirectory, file);
        fs.copyFileSync(src, dest);
        console.log(`\t[SUCCESS] Copied ${file} to ${platform} resources.`);
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('\t[FINISH] Temporary files cleaned up.');
}

function updateAppDelegate(filePath) {

    const fs = require('fs');
    const path = require('path');

    if (!fs.existsSync(filePath)) {
        console.error('\t[ERROR] AppDelegate.swift file was not found at:', filePath);
        process.exit(1);
    }

    let content = fs.readFileSync(filePath, 'utf8');

    // Add imports if missing
    if (!content.includes('import FirebaseCore')) {
        content = content.replace('import Capacitor', 'import Capacitor\nimport FirebaseCore');
    }
    if (!content.includes('import OSFirebaseMessagingLib')) {
        content = content.replace('import FirebaseCore', 'import FirebaseCore\nimport OSFirebaseMessagingLib');
    }

    // Inject FirebaseMessagingApplicationDelegate call into didFinishLaunchingWithOptions if not present
    content = content.replace(
        /(func application\(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\?\) -> Bool \{)([\s\S]*?)(\n\s*return\s+true)/,
        (match, start, middle, end) => {
        if (middle.includes("FirebaseMessagingApplicationDelegate.shared.application")) {
            return match; // Already injected
        }
        return `${start}${middle}\n        FirebaseMessagingApplicationDelegate.shared.application(application, didFinishLaunchingWithOptions: launchOptions)${end}`;
        }
    );

    // Add the FirebaseMessagingApplicationDelegate for Firebase methods and fixSoundPath if not already present
    if (!content.includes('func application(_ application: UIApplication, didReceiveRemoteNotification')) {
        const insertion = `

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable : Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        // sounds from OutSystems capacitor builds go to a specific directory, we should ensure the sound path is correct
        let updatedUserInfo = fixSoundPath(userInfo)
        FirebaseMessagingApplicationDelegate.shared.application(application, didReceiveRemoteNotification: updatedUserInfo, fetchCompletionHandler: completionHandler)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        FirebaseMessagingApplicationDelegate.shared.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
    }

    private func fixSoundPath(_ userInfo: [AnyHashable : Any]) -> [AnyHashable : Any] {
        guard var newInfo = userInfo as? [String: Any],
              let notificationString = newInfo["notification"] as? String,
              let notificationData = notificationString.data(using: .utf8),
              var notificationDict = try? JSONSerialization.jsonObject(with: notificationData) as? [String: Any],
              let sound = notificationDict["sound"] as? String,
              !sound.hasPrefix("public/") else {
            return userInfo
        }
        notificationDict["sound"] = "public/\\(sound)"
        if let updatedData = try? JSONSerialization.data(withJSONObject: notificationDict, options: []),
           let updatedString = String(data: updatedData, encoding: .utf8) {
            newInfo["notification"] = updatedString
        } else {
            return userInfo
        }
        return newInfo
    }
`;
        // Add before last closing brace of the class
        content = content.replace(/\n\}/, `${insertion}\n}`);
    }

    fs.writeFileSync(filePath, content, 'utf8');
    console.log('\t[SUCCESS] AppDelegate.swift updated successfully.');

}

function addNotificationServiceExtension() {
    const xcode = require('xcode');

    const NSE_TARGET_NAME = 'NotificationService';
    const NSE_SOURCE_FILES = ['NotificationService.swift', 'Info.plist'];

    // Bundle ID lives in the root capacitor.config.json as appId
    let bundleId;
    const capConfigPath = path.resolve(projectDirPath, 'capacitor.config.json');
    try {
        bundleId = JSON.parse(fs.readFileSync(capConfigPath, 'utf8')).appId;
    } catch (e) {
        console.error('\t[ERROR] Could not read capacitor.config.json for bundle ID:', e.message);
        return;
    }

    if (!bundleId) {
        console.warn('\t[WARNING] appId missing from capacitor.config.json — skipping NSE setup.');
        return;
    }

    // Capacitor Xcode project: ios/App/App.xcodeproj
    const pbxprojPath = path.resolve(projectDirPath, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    if (!fs.existsSync(pbxprojPath)) {
        console.warn('\t[WARNING] Xcode project not found at:', pbxprojPath, '— skipping NSE setup.');
        return;
    }

    const proj = xcode.project(pbxprojPath);
    proj.parseSync();

    // Idempotency: skip if target already exists
    const nativeTargets = proj.pbxNativeTargetSection();
    const alreadyExists = Object.values(nativeTargets).some(
        t => t && (t.name === NSE_TARGET_NAME || t.name === `"${NSE_TARGET_NAME}"`)
    );
    if (alreadyExists) {
        console.log('\t[SKIPPED] NotificationService target already present.');
        return;
    }

    // Copy NSE files into ios/App/App/NotificationService/
    // __dirname is <plugin-root>/build-actions/, so ../src/ios/NotificationService/ is the plugin source
    const nseSrcDir = path.resolve(__dirname, '..', 'src', 'ios', 'NotificationService');
    const nseDstDir = path.resolve(projectDirPath, 'ios', 'App', 'App', NSE_TARGET_NAME);
    if (!fs.existsSync(nseDstDir)) {
        fs.mkdirSync(nseDstDir, { recursive: true });
    }

    for (const file of NSE_SOURCE_FILES) {
        const src = path.join(nseSrcDir, file);
        const dst = path.join(nseDstDir, file);
        if (!fs.existsSync(src)) {
            console.error('\t[ERROR] NSE source file missing:', src);
            return;
        }
        fs.copyFileSync(src, dst);
    }

    const nseBundleId = `${bundleId}.${NSE_TARGET_NAME}`;

    // Add app extension target
    const nseTarget = proj.addTarget(NSE_TARGET_NAME, 'app_extension', NSE_TARGET_NAME, nseBundleId);
    if (!nseTarget) {
        console.error('\t[ERROR] Failed to add NSE target to Xcode project.');
        return;
    }

    // Paths are relative to the .xcodeproj parent (ios/App/)
    proj.addSourceFile(`App/${NSE_TARGET_NAME}/NotificationService.swift`, { target: nseTarget.uuid });
    proj.addResourceFile(`App/${NSE_TARGET_NAME}/Info.plist`, { target: nseTarget.uuid });

    // Apply build settings to the NSE target's configurations
    const buildConfigs = proj.pbxXCBuildConfigurationSection();
    Object.keys(buildConfigs).forEach(key => {
        const config = buildConfigs[key];
        if (typeof config !== 'object' || !config.buildSettings) return;
        const pb = config.buildSettings;
        if (pb.PRODUCT_NAME !== `"${NSE_TARGET_NAME}"` && pb.PRODUCT_NAME !== NSE_TARGET_NAME) return;
        pb.SWIFT_VERSION = '5.0';
        pb.IPHONEOS_DEPLOYMENT_TARGET = '14.0';
        pb.PRODUCT_BUNDLE_IDENTIFIER = `"${nseBundleId}"`;
        pb.TARGETED_DEVICE_FAMILY = '"1,2"';
        pb.CODE_SIGN_ENTITLEMENTS = '';
    });

    proj.writeSync();
    console.log(`\t[SUCCESS] NotificationService extension added (bundle ID: ${nseBundleId}).`);
}
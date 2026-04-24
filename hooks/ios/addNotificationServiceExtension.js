'use strict';

const path = require('path');
const fs = require('fs');
const { ConfigParser } = require('cordova-common');

const NSE_TARGET_NAME = 'NotificationService';
const NSE_SOURCE_FILES = ['NotificationService.swift', 'Info.plist'];

// xcode is a dependency of cordova-ios, not this plugin.
// We find it at runtime from the Cordova project's node_modules because the
// plugin's own node_modules are NOT copied into platforms/plugins/.
function requireXcode(projectRoot) {
    const candidates = [
        path.resolve(projectRoot, 'node_modules', 'xcode'),
        path.resolve(projectRoot, 'node_modules', 'cordova-ios', 'node_modules', 'xcode'),
        'xcode',
    ];
    for (const p of candidates) {
        try { return require(p); } catch (_) {}
    }
    return null;
}

function findMainTargetUuid(proj, appName) {
    const nativeTargets = proj.pbxNativeTargetSection();
    for (const [uuid, target] of Object.entries(nativeTargets)) {
        if (!target || typeof target !== 'object' || uuid.endsWith('_comment')) continue;
        const name = target.name && target.name.replace(/^"(.*)"$/, '$1');
        if (name === appName) return uuid;
    }
    return null;
}

function addEmbedExtensionsPhase(proj, mainTargetUuid, nseTargetUuid) {
    // Build file that references the NSE .appex product
    const nseNativeTarget = proj.pbxNativeTargetSection()[nseTargetUuid];
    const productRefUuid = nseNativeTarget.productReference;

    const buildFileUuid = proj.generateUuid();
    proj.pbxBuildFileSection()[buildFileUuid] = {
        isa: 'PBXBuildFile',
        fileRef: productRefUuid,
        fileRef_comment: `${NSE_TARGET_NAME}.appex`,
        settings: { ATTRIBUTES: ['RemoveHeadersOnCopy'] },
    };
    proj.pbxBuildFileSection()[`${buildFileUuid}_comment`] = `${NSE_TARGET_NAME}.appex in Embed App Extensions`;

    // PBXCopyFilesBuildPhase with dstSubfolderSpec=13 (Plug-ins)
    const phaseUuid = proj.generateUuid();
    const copyFilesSection = proj.hash.project.objects['PBXCopyFilesBuildPhase'] =
        proj.hash.project.objects['PBXCopyFilesBuildPhase'] || {};

    copyFilesSection[phaseUuid] = {
        isa: 'PBXCopyFilesBuildPhase',
        buildActionMask: '2147483647',
        dstPath: '""',
        dstSubfolderSpec: 13,
        files: [{ value: buildFileUuid, comment: `${NSE_TARGET_NAME}.appex in Embed App Extensions` }],
        name: '"Embed App Extensions"',
        runOnlyForDeploymentPostprocessing: 0,
    };
    copyFilesSection[`${phaseUuid}_comment`] = 'Embed App Extensions';

    // Attach phase to the main app target
    const mainTarget = proj.pbxNativeTargetSection()[mainTargetUuid];
    if (!mainTarget.buildPhases) mainTarget.buildPhases = [];
    mainTarget.buildPhases.push({ value: phaseUuid, comment: 'Embed App Extensions' });
}

module.exports = function (context) {
    const platforms = context.opts.platforms || (context.opts.cordova && context.opts.cordova.platforms) || [];
    if (!platforms.includes('ios') && platforms.length > 0) return;

    const projectRoot = context.opts.cordova && context.opts.cordova.project
        ? context.opts.cordova.project.root
        : context.opts.projectRoot;

    const xcode = requireXcode(projectRoot);
    if (!xcode) {
        console.warn('FCM_NSE: xcode module not found — skipping NotificationService extension setup.');
        return;
    }

    const configPath = path.join(projectRoot, 'config.xml');
    const configParser = new ConfigParser(configPath);
    const appName = configParser.name();
    const mainBundleId = configParser.packageName();

    if (!appName || !mainBundleId) {
        console.warn('FCM_NSE: Could not determine app name or bundle ID — skipping NSE setup.');
        return;
    }

    const iosPlatformPath = path.join(projectRoot, 'platforms', 'ios');
    const iosAppDir = path.join(iosPlatformPath, appName);

    if (!fs.existsSync(iosAppDir)) {
        console.warn(`FCM_NSE: iOS app directory not found at ${iosAppDir} — skipping NSE setup.`);
        return;
    }

    // Find .xcodeproj
    const entries = fs.readdirSync(iosPlatformPath);
    const xcodeprojName = entries.find(e => e.endsWith('.xcodeproj'));
    if (!xcodeprojName) {
        console.warn('FCM_NSE: No .xcodeproj found — skipping NSE setup.');
        return;
    }

    const pbxprojPath = path.join(iosPlatformPath, xcodeprojName, 'project.pbxproj');
    const proj = xcode.project(pbxprojPath);
    proj.parseSync();

    // Idempotency: skip if NSE target already exists
    const nativeTargets = proj.pbxNativeTargetSection();
    const alreadyExists = Object.values(nativeTargets).some(
        t => t && (t.name === NSE_TARGET_NAME || t.name === `"${NSE_TARGET_NAME}"`)
    );
    if (alreadyExists) {
        console.log('FCM_NSE: NotificationService target already present — skipping.');
        return;
    }

    // Copy NSE source files into the platform directory
    const nseSrcDir = path.join(__dirname, '..', '..', 'src', 'ios', 'NotificationService');
    const nseDstDir = path.join(iosAppDir, NSE_TARGET_NAME);
    if (!fs.existsSync(nseDstDir)) {
        fs.mkdirSync(nseDstDir, { recursive: true });
    }

    for (const file of NSE_SOURCE_FILES) {
        const src = path.join(nseSrcDir, file);
        const dst = path.join(nseDstDir, file);
        if (!fs.existsSync(src)) {
            console.error(`FCM_NSE: Source file missing: ${src}`);
            return;
        }
        fs.copyFileSync(src, dst);
    }

    const nseBundleId = `${mainBundleId}.${NSE_TARGET_NAME}`;

    // Add new app extension target
    const nseTarget = proj.addTarget(NSE_TARGET_NAME, 'app_extension', NSE_TARGET_NAME, nseBundleId);

    if (!nseTarget) {
        console.error('FCM_NSE: Failed to add NSE target to Xcode project.');
        return;
    }

    // Add source and resource files scoped to the NSE target
    const swiftPath = `${appName}/${NSE_TARGET_NAME}/NotificationService.swift`;
    const plistPath = `${appName}/${NSE_TARGET_NAME}/Info.plist`;

    proj.addSourceFile(swiftPath, { target: nseTarget.uuid });
    proj.addResourceFile(plistPath, { target: nseTarget.uuid });

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

    // Wire NSE into the main app target:
    // 1. Target dependency so Xcode builds the NSE before the main app
    // 2. Embed App Extensions phase so the .appex is copied into Wodify.app/PlugIns/
    const mainTargetUuid = findMainTargetUuid(proj, appName);
    if (mainTargetUuid) {
        proj.addTargetDependency(mainTargetUuid, [nseTarget.uuid]);
        addEmbedExtensionsPhase(proj, mainTargetUuid, nseTarget.uuid);
    } else {
        console.warn(`FCM_NSE: Could not find main target '${appName}' — extension will not be embedded.`);
    }

    proj.writeSync();
    console.log(`FCM_NSE: NotificationService extension added successfully (bundle ID: ${nseBundleId}).`);
};

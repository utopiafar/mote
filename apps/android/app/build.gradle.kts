plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
val releaseSecrets = listOf("MOTE_ANDROID_KEYSTORE_PATH", "MOTE_ANDROID_KEYSTORE_PASSWORD", "MOTE_ANDROID_KEY_ALIAS", "MOTE_ANDROID_KEY_PASSWORD")
    .associateWith { providers.environmentVariable(it).orNull }
val releaseSigningReady = releaseSecrets.values.all { !it.isNullOrBlank() }
android {
    namespace = "dev.mote.collector"
    compileSdk = 36
    ndkVersion = "28.2.13676358"
    defaultConfig {
        applicationId = "dev.mote.collector"
        minSdk = 29
        targetSdk = 36
        versionCode = 57
        versionName = "0.0.46"
        buildConfigField("String", "MOTE_PROFILE", "\"legacy\"")
        buildConfigField("String", "DEFAULT_SERVER", "\"\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild { cmake { arguments += "-DANDROID_STL=c++_shared"; targets += "mote_vlm" } }
    }
    signingConfigs {
        if (releaseSigningReady) create("distribution") {
            storeFile = file(releaseSecrets.getValue("MOTE_ANDROID_KEYSTORE_PATH")!!)
            storePassword = releaseSecrets.getValue("MOTE_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = releaseSecrets.getValue("MOTE_ANDROID_KEY_ALIAS")
            keyPassword = releaseSecrets.getValue("MOTE_ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        debug { manifestPlaceholders["cleartextAllowed"] = "true" }
        create("development") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("distribution")
            buildConfigField("String", "MOTE_PROFILE", "\"dev\"")
            buildConfigField("String", "DEFAULT_SERVER", "\"http://127.0.0.1:47842\"")
            matchingFallbacks += "debug"
        }
        create("fileFixture") {
            initWith(getByName("development"))
            applicationIdSuffix = ".filefixture"
            versionNameSuffix = "-filefixture"
            matchingFallbacks += "development"
        }
        release {
            manifestPlaceholders["cleartextAllowed"] = "false"
            isMinifyEnabled = false
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("distribution")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true; aidl = true }
    sourceSets.getByName("test").java.srcDir("src/sharedTest/java")
    sourceSets.getByName("androidTest").java.srcDir("src/sharedTest/java")
    sourceSets.getByName("development").apply {
        java.srcDir("src/debug/java")
        res.srcDir("src/debug/res")
        manifest.srcFile("src/debug/AndroidManifest.xml")
    }
    sourceSets.getByName("fileFixture").apply {
        java.srcDir("src/debug/java")
        res.srcDir("src/debug/res")
        manifest.srcFile("src/debug/AndroidManifest.xml")
    }
    testBuildType = providers.gradleProperty("mote.testBuildType").orElse("debug").get()
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/modelAssets"))
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    lint { abortOnError = true }
}
dependencies {
    implementation("com.tom-roush:pdfbox-android:2.0.27.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.4")
    implementation("com.android.tools.build:apksig:8.11.1")
    implementation("androidx.work:work-runtime-ktx:2.10.2")
    implementation("com.google.mlkit:text-recognition:16.0.1")
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
tasks.matching { it.name == "packageRelease" }.configureEach {
    doFirst { check(releaseSigningReady) { "Release signing requires all four MOTE_ANDROID_KEYSTORE_PATH/PASSWORD and MOTE_ANDROID_KEY_ALIAS/PASSWORD environment settings. No unsigned release is produced." } }
}
val copyModelManifest by tasks.registering(Sync::class) {
    from(rootProject.file("../../models/qwen-manifest.json"))
    from(rootProject.file("../../models/review-policy.txt"))
    from(rootProject.file("../../models/review-system.txt"))
    from(rootProject.file("../../models/review-grammar.gbnf"))
    from(rootProject.file("../../release/release-public-key.pem"))
    from(rootProject.file("../../licenses")) { into("licenses") }
    into(layout.buildDirectory.dir("generated/modelAssets"))
    doFirst { check(rootProject.file("../../models/qwen-manifest.json").exists()) { "Missing shared models/qwen-manifest.json" } }
}
tasks.named("preBuild").configure { dependsOn(copyModelManifest) }

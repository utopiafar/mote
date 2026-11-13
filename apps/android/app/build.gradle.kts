import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
val releaseVersion = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
val releaseSecrets = listOf("MOTE_ANDROID_KEYSTORE_PATH", "MOTE_ANDROID_KEYSTORE_PASSWORD", "MOTE_ANDROID_KEY_ALIAS", "MOTE_ANDROID_KEY_PASSWORD")
    .associateWith { providers.environmentVariable(it).orNull }
val releaseSigningReady = releaseSecrets.values.all { !it.isNullOrBlank() }
val devRun = providers.environmentVariable("MOTE_ANDROID_DEV_RUN").orNull?.takeIf { it.isNotEmpty() }?.let {
    require(it.matches(Regex("[1-9]\\d*"))) { "Invalid Android Dev workflow run number" }
    it.toLong().also { run -> require(run in 1..1_100_000_000L) { "Invalid Android Dev workflow run number" } }
}
android {
    namespace = "dev.mote.collector"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.mote.collector"
        minSdk = 29
        targetSdk = 36
        versionCode = releaseVersion.getProperty("versionCode").toInt()
        versionName = releaseVersion.getProperty("versionName")
        buildConfigField("String", "MOTE_PROFILE", "\"prod\"")
        buildConfigField("String", "DEFAULT_SERVER", "\"\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
        debug {
            applicationIdSuffix = ".test"
            versionNameSuffix = "-test"
            buildConfigField("String", "MOTE_PROFILE", "\"test\"")
            manifestPlaceholders["cleartextAllowed"] = "true"
        }
        create("development") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".dev"
            versionNameSuffix = if (devRun != null) "-dev.$devRun" else "-dev"
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("distribution")
            buildConfigField("String", "MOTE_PROFILE", "\"dev\"")
            buildConfigField("String", "DEFAULT_SERVER", "\"http://127.0.0.1:47842\"")
            matchingFallbacks += "debug"
        }
        create("fileFixture") {
            initWith(getByName("development"))
            applicationIdSuffix = ".filefixture"
            versionNameSuffix = "-filefixture"
            buildConfigField("String", "MOTE_PROFILE", "\"test\"")
            buildConfigField("String", "DEFAULT_SERVER", "\"\"")
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
    buildFeatures { buildConfig = true }
    sourceSets.getByName("test").resources.srcDir(rootProject.file("../../adapters/ui/fixtures"))
    sourceSets.getByName("test").resources.srcDir(rootProject.file("../../packages/shared/test-fixtures"))
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
    testOptions { unitTests.isIncludeAndroidResources = true }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/runtimeAssets"))
    lint { abortOnError = true }
}
androidComponents {
    onVariants(selector().withBuildType("development")) { variant ->
        if (devRun != null) variant.outputs.forEach { it.versionCode.set((1_000_000_000L + devRun).toInt()) }
    }
}
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.4")
    implementation("com.android.tools.build:apksig:8.11.1")
    implementation("androidx.work:work-runtime-ktx:2.10.2")
    implementation("com.google.mlkit:text-recognition:16.0.1")
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("org.robolectric:robolectric:4.17")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
tasks.matching { it.name == "packageRelease" }.configureEach {
    doFirst { check(releaseSigningReady) { "Release signing requires all four MOTE_ANDROID_KEYSTORE_PATH/PASSWORD and MOTE_ANDROID_KEY_ALIAS/PASSWORD environment settings. No unsigned release is produced." } }
}
val copyRuntimeAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../../adapters/ui/builtin.json")) { rename { "ui-page-rules.json" } }
    from(rootProject.file("../../release/release-public-key.pem"))
    from(rootProject.file("../../licenses")) { into("licenses") }
    into(layout.buildDirectory.dir("generated/runtimeAssets"))
}
tasks.named("preBuild").configure { dependsOn(copyRuntimeAssets) }

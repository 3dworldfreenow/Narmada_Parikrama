plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.opirsys.narmada"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.opirsys.narmada"
        minSdk = 24
        targetSdk = 34
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "1.0"
    }

    signingConfigs {
        create("shared") {
            // CI passes a keystore via secrets if set; otherwise the repo's shared key is used
            // so that new APKs install over old ones without losing data.
            storeFile = file(System.getenv("KEYSTORE_FILE") ?: "../narmada-debug.keystore")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "narmada123"
            keyAlias = System.getenv("KEY_ALIAS") ?: "narmada"
            keyPassword = System.getenv("KEY_PASSWORD") ?: "narmada123"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}

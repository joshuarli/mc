plugins {
    java
}

group = "dev.arena"
version = "0.1.0"

repositories {
    maven("https://repo.papermc.io/repository/maven-public/")
}

val paperApiGroup = providers.gradleProperty("paperApiGroup").get()
val paperApiArtifact = providers.gradleProperty("paperApiArtifact").get()
val paperApiVersion = providers.gradleProperty("paperApiVersion").get()
val pluginApiVersion = providers.gradleProperty("pluginApiVersion").get()

dependencies {
    compileOnly("$paperApiGroup:$paperApiArtifact:$paperApiVersion")
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:6.1.3")
}

dependencyLocking {
    lockAllConfigurations()
}

java {
    toolchain.languageVersion = JavaLanguageVersion.of(25)
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 25
}

tasks.processResources {
    inputs.property("pluginApiVersion", pluginApiVersion)
    filesMatching("plugin.yml") {
        expand("pluginApiVersion" to pluginApiVersion)
    }
}

tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    useJUnitPlatform()
}

layout.buildDirectory.set(file("../../.work/arena/gradle-build"))

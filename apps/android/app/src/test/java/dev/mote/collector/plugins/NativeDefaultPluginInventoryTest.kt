package dev.mote.collector.plugins

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** The default build performs one reconciliation: every APK manifest
 * component has exactly one plugin or host-primitive owner, every declared
 * provider capability has one package, and stopping a package scope removes
 * its routes, services and jobs. */
class NativeDefaultPluginInventoryTest {
    private fun manifestFile(): File {
        val candidates = listOf(
            File("src/main/AndroidManifest.xml"),
            File("app/src/main/AndroidManifest.xml"),
            File(System.getProperty("user.dir"), "src/main/AndroidManifest.xml"),
            File(System.getProperty("user.dir"), "app/src/main/AndroidManifest.xml"),
        )
        return candidates.firstOrNull(File::isFile)
            ?: error("AndroidManifest.xml not found from ${System.getProperty("user.dir")}")
    }

    /** The manifest produced by the APK build. It also contains merged library
     * components, which belong to their libraries rather than this app's
     * plugins; the packaged comparison below filters to the source inventory. */
    private fun packagedManifestFile(): File? = listOf(
        File("build/intermediates/packaged_manifests/debug/processDebugManifestForPackage/AndroidManifest.xml"),
        File("app/build/intermediates/packaged_manifests/debug/processDebugManifestForPackage/AndroidManifest.xml"),
        File(System.getProperty("user.dir"), "build/intermediates/packaged_manifests/debug/processDebugManifestForPackage/AndroidManifest.xml"),
        File(System.getProperty("user.dir"), "app/build/intermediates/packaged_manifests/debug/processDebugManifestForPackage/AndroidManifest.xml"),
    ).firstOrNull(File::isFile)

    private fun ownerTag(element: Element): String? {
        val children = element.childNodes
        for (index in 0 until children.length) {
            val child = children.item(index) as? Element ?: continue
            if (child.tagName == "meta-data" && child.getAttribute("android:name") == "mote.plugin.owner")
                return child.getAttribute("android:value")
        }
        return null
    }

    private fun manifestComponents(file: File = manifestFile()): List<NativeManifestComponent> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val root = document.documentElement
        fun names(kind: String): List<NativeManifestComponent> {
            val nodes = root.getElementsByTagName(kind)
            return (0 until nodes.length).mapNotNull { index ->
                val element = nodes.item(index) as? Element ?: return@mapNotNull null
                val name = element.getAttribute("android:name")
                if (name.isBlank()) null else NativeManifestComponent(kind, name, ownerTag(element))
            }
        }
        val application = (root.getElementsByTagName("application").item(0) as? Element)
            ?.getAttribute("android:name")
            ?.takeIf(String::isNotBlank)
            ?.let { listOf(NativeManifestComponent("application", it, ownerTag(root.getElementsByTagName("application").item(0) as Element))) }
            .orEmpty()
        return application + names("activity") + names("service") + names("receiver") + names("provider")
    }

    private fun key(component: NativeManifestComponent) = "${component.kind}:${NativeDefaultPluginInventory.canonical(component.name)}"

    @Test
    fun `every packaged manifest component and provider has one default owner`() {
        val source = manifestComponents()
        val errors = NativeDefaultPluginInventory.reconcile(source)
        assertTrue(errors.joinToString("\n"), errors.isEmpty())

        packagedManifestFile()?.let { packagedFile ->
            val sourceKeys = source.map(::key).toSet()
            val packaged = manifestComponents(packagedFile).filter { key(it) in sourceKeys }
            assertEquals("the packaged APK keeps every default component", sourceKeys, packaged.map(::key).toSet())
            val packagedErrors = NativeDefaultPluginInventory.reconcile(packaged)
            assertTrue(packagedErrors.joinToString("\n"), packagedErrors.isEmpty())
        }

        val registered = NativePluginRegistry().apply { registerBuiltinPlugins("generated-build") }
        val expected = NativeDefaultPluginInventory.packages.flatMap { it.capabilities }.toSet()
        val actual = registered.list().map { it.capability }.toSet()
        assertEquals("the default package list is the registry inventory", expected, actual)
        assertEquals("no capability has two owners", NativeDefaultPluginInventory.packages.flatMap { it.capabilities }.size, expected.size)

        val packaged = NativePluginRegistry().apply { registerBuiltinPlugins("packaged-build") }
        assertEquals(
            "the packaged build projects the same default registry",
            registered.list().map { it.capability },
            packaged.list().map { it.capability },
        )
    }

    @Test
    fun `stopping each default package withdraws its routes services and jobs`() {
        val host = NativePluginHost(NativePluginRegistry().apply { registerBuiltinPlugins("generated-build") })
        for (pkg in NativeDefaultPluginInventory.packages) {
            val identity = PluginInstanceIdentity(pkg.packageId, "generated-installation", pkg.packageId)
            val admitted = host.createScope(PluginInstanceDescriptor(identity, pkg.capabilities.toSet(), requires = pkg.capabilities.map { NativeRequirement(it, "1") }))
            val scope = (admitted as PluginResult.Ok).value
            var disposed = 0
            val started = host.startPlugin(scope) { owner ->
                owner.registerRoute("${pkg.packageId}.route") { _, _ -> object : PluginViewContribution {
                    override val routeId = "${pkg.packageId}.route"
                    override fun dispose() { disposed++ }
                } }
                for (capability in pkg.capabilities)
                    owner.registerService(PluginServiceRegistration("${pkg.packageId}.${capability.substringAfterLast('.')}", "$capability.${pkg.packageId.substringAfterLast('.')}"))
                owner.registerJob(PluginJob("${pkg.packageId}.job", durable = true))
                owner.defer { disposed++ }
            }
            assertTrue(started is PluginResult.Ok)
            assertNotNull(host.route("${pkg.packageId}.route"))
            assertEquals(pkg.capabilities.size, scope.services.size)
            assertEquals(1, scope.jobs.size)
            scope.createView().registerView(object : PluginViewContribution {
                override val routeId = "${pkg.packageId}.view"
                override fun dispose() { disposed++ }
            })

            assertEquals(emptyList<Throwable>(), host.stopScope(pkg.packageId))
            assertNull("route is withdrawn", host.route("${pkg.packageId}.route"))
            assertTrue("services are withdrawn", scope.services.isEmpty())
            assertTrue("jobs are withdrawn", scope.jobs.isEmpty())
            assertTrue("scope is revoked", scope.revoked)
            assertEquals("the object owner runs exactly once", 2, disposed)
            assertFalse(scope.routes.containsKey("${pkg.packageId}.route"))
        }
    }
}

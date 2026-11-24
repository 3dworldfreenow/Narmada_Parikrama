package com.opirsys.narmada

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.RandomAccessFile

/**
 * The app is the map UI (assets/www) running in a WebView, plus a few native helpers:
 *  - serves the downloaded offline map file with HTTP Range support (/offline/narmada.pmtiles)
 *  - records the journey in a foreground service (works offline and with the screen off)
 *  - photo / video picker for updates, and downloading the offline map from the server
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var geoCallback: Pair<String, GeolocationPermissions.Callback>? = null

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    private fun mapDir(): File = File(getExternalFilesDir(null) ?: filesDir, "maps").apply { mkdirs() }
    private fun mapFile(): File = File(mapDir(), "narmada.pmtiles")
    private fun mapPart(): File = File(mapDir(), "narmada.pmtiles.part")

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW   // allows an http:// server before HTTPS is set up
            allowFileAccess = false
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        web.addJavascriptInterface(Bridge(), "Android")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.host == "appassets.androidplatform.net" && url.path == "/offline/narmada.pmtiles") {
                    return serveMapRange(request.requestHeaders)
                }
                return assetLoader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "appassets.androidplatform.net") return false
                // everything else (Google Maps navigation, YouTube, links) opens outside the app
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (hasLocationPermission()) callback.invoke(origin, true, true)
                else { geoCallback = origin to callback; askPermissions() }
            }

            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                val intent = params.createIntent().apply {
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try { startActivityForResult(intent, REQ_FILE); true }
                catch (e: Exception) { fileCallback = null; false }
            }
        }

        askPermissions()
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    // ---------------------------------------------------------------- offline map with Range support
    private fun serveMapRange(headers: Map<String, String>): WebResourceResponse {
        val f = mapFile()
        val cors = mutableMapOf("Access-Control-Allow-Origin" to "*", "Accept-Ranges" to "bytes",
            "Access-Control-Expose-Headers" to "Content-Range, Content-Length, Accept-Ranges")
        if (!f.exists()) {
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", cors, ByteArrayInputStream(ByteArray(0)))
        }
        val size = f.length()
        val range = headers.entries.firstOrNull { it.key.equals("Range", true) }?.value
        var start = 0L
        var end = size - 1
        if (range != null && range.startsWith("bytes=")) {
            val parts = range.removePrefix("bytes=").split("-")
            if (parts[0].isNotEmpty()) start = parts[0].toLong()
            if (parts.size > 1 && parts[1].isNotEmpty()) end = minOf(parts[1].toLong(), size - 1)
            if (parts[0].isEmpty() && parts.size > 1) { start = maxOf(0, size - parts[1].toLong()); end = size - 1 }
        } else {
            end = minOf(size - 1, 16L * 1024 - 1)   // never send the whole (huge) file in one go
        }
        val len = (end - start + 1).coerceAtLeast(0).toInt()
        val buf = ByteArray(len)
        RandomAccessFile(f, "r").use { it.seek(start); it.readFully(buf) }
        cors["Content-Range"] = "bytes $start-$end/$size"
        cors["Content-Length"] = len.toString()
        return WebResourceResponse("application/octet-stream", null, 206, "Partial Content", cors, ByteArrayInputStream(buf))
    }

    // ---------------------------------------------------------------- permissions
    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun askPermissions() {
        val want = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) want += Manifest.permission.POST_NOTIFICATIONS
        val missing = want.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty() && Build.VERSION.SDK_INT >= 23) requestPermissions(missing.toTypedArray(), REQ_PERM)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        geoCallback?.let { (origin, cb) -> cb.invoke(origin, hasLocationPermission(), true) }
        geoCallback = null
        web.evaluateJavascript("window.onNativePermission && window.onNativePermission(${hasLocationPermission()})", null)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE) return
        val cb = fileCallback ?: return
        fileCallback = null
        if (resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { cd -> for (i in 0 until cd.itemCount) uris += cd.getItemAt(i).uri }
        if (uris.isEmpty()) data.data?.let { uris += it }
        cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.appBack ? window.appBack() : false") { handled ->
            if (handled != "true") {
                if (web.canGoBack()) web.goBack() else finish()
            }
        }
    }

    // ---------------------------------------------------------------- bridge for the web UI
    inner class Bridge {
        @JavascriptInterface fun appVersion(): String =
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0"

        // ----- journey recording
        @JavascriptInterface fun startTracking(): Boolean {
            if (!hasLocationPermission()) { runOnUiThread { askPermissions() }; return false }
            ContextCompat.startForegroundService(this@MainActivity, Intent(this@MainActivity, LocationService::class.java))
            return true
        }
        @JavascriptInterface fun stopTracking() {
            startService(Intent(this@MainActivity, LocationService::class.java).setAction(LocationService.ACTION_STOP))
        }
        @JavascriptInterface fun isTracking(): Boolean = LocationService.running
        @JavascriptInterface fun pendingPoints(limit: Int): String = PointStore.read(this@MainActivity, limit)
        @JavascriptInterface fun pointCount(): Int = PointStore.count(this@MainActivity)
        @JavascriptInterface fun clearPoints(upToTs: Double) = PointStore.clearUpTo(this@MainActivity, upToTs)

        // ----- offline map
        @JavascriptInterface fun hasOfflineMap(): Boolean = mapFile().exists() && mapFile().length() > 1024
        @JavascriptInterface fun offlineMapBytes(): Long = if (mapFile().exists()) mapFile().length() else 0
        @JavascriptInterface fun deleteOfflineMap() { mapFile().delete(); mapPart().delete() }

        @JavascriptInterface fun downloadMap(url: String, token: String): Long {
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            mapPart().delete()
            val req = DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("Authorization", "Bearer $token")
                .setTitle("Narmada offline map")
                .setDescription("Map of the parikrama region for use without internet")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationUri(Uri.fromFile(mapPart()))
                .setAllowedOverMetered(true)
            val id = dm.enqueue(req)
            getSharedPreferences("app", MODE_PRIVATE).edit().putLong("map_dl", id).apply()
            return id
        }

        /** {"state": "none|running|done|failed", "bytes": n, "total": n} */
        @JavascriptInterface fun mapDownloadStatus(): String {
            val id = getSharedPreferences("app", MODE_PRIVATE).getLong("map_dl", -1)
            val out = JSONObject().put("state", "none").put("bytes", 0).put("total", 0)
            if (id < 0) return out.toString()
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.query(DownloadManager.Query().setFilterById(id)).use { c ->
                if (!c.moveToFirst()) return out.toString()
                val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                out.put("bytes", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)))
                out.put("total", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)))
                when (status) {
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        if (mapPart().exists()) { mapFile().delete(); mapPart().renameTo(mapFile()) }
                        getSharedPreferences("app", MODE_PRIVATE).edit().remove("map_dl").apply()
                        out.put("state", "done")
                    }
                    DownloadManager.STATUS_FAILED -> {
                        getSharedPreferences("app", MODE_PRIVATE).edit().remove("map_dl").apply()
                        out.put("state", "failed")
                    }
                    else -> out.put("state", "running")
                }
            }
            return out.toString()
        }

        @JavascriptInterface fun freeSpaceBytes(): Long = mapDir().usableSpace

        @JavascriptInterface fun openExternal(url: String) {
            runOnUiThread { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
        }
    }

    companion object {
        const val REQ_FILE = 11
        const val REQ_PERM = 12
    }
}

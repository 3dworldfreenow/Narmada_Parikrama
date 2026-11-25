package com.opirsys.narmada

import android.content.Context
import java.net.HttpURLConnection
import java.net.URL

/**
 * Small HTTP helper the background service uses when the app screen is not open.
 * The web UI hands over the server address, the login token and the live-sharing
 * choice (Bridge.setAuth); they are kept in the app's private storage.
 */
object Net {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("net", Context.MODE_PRIVATE)
    fun live(ctx: Context) = prefs(ctx).getBoolean("live", false) && token(ctx).isNotEmpty()
    fun setLive(ctx: Context, on: Boolean) = prefs(ctx).edit().putBoolean("live", on).apply()
    private fun token(ctx: Context) = prefs(ctx).getString("token", "") ?: ""
    private fun server(ctx: Context) = (prefs(ctx).getString("server", "") ?: "").trimEnd('/')

    fun save(ctx: Context, server: String, token: String, live: Boolean) =
        prefs(ctx).edit().putString("server", server).putString("token", token).putBoolean("live", live).apply()

    /** POST to /api/v1<path>; returns the HTTP status, or -1 without internet. */
    fun post(ctx: Context, path: String, body: String, type: String): Int {
        val t = token(ctx); val s = server(ctx)
        if (t.isEmpty() || s.isEmpty()) return -1
        return try {
            val c = URL("$s/api/v1$path").openConnection() as HttpURLConnection
            c.requestMethod = "POST"; c.doOutput = true
            c.connectTimeout = 15_000; c.readTimeout = 30_000
            c.setRequestProperty("Authorization", "Bearer $t")
            c.setRequestProperty("Content-Type", type)
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            runCatching { (if (code < 400) c.inputStream else c.errorStream)?.close() }
            c.disconnect()
            if (code == 401) prefs(ctx).edit().putString("token", "").apply()   // logged out elsewhere
            code
        } catch (e: Exception) { -1 }
    }

    /** Send journey points recorded on the phone, oldest first, then forget the sent ones. */
    fun uploadPoints(ctx: Context) {
        repeat(10) {
            val pts = PointStore.read(ctx, 2000)
            if (pts == "[]") return
            val arr = org.json.JSONArray(pts)
            var maxTs = 0.0
            for (i in 0 until arr.length()) maxTs = maxOf(maxTs, arr.getJSONObject(i).getDouble("ts"))
            val code = post(ctx, "/timeline/points", "{\"points\":$pts}", "application/json")
            if (code !in 200..299) return
            PointStore.clearUpTo(ctx, maxTs)
        }
    }
}

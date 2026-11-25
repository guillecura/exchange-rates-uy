package uy.exchangerates

import java.net.HttpURLConnection
import java.net.URI

/** One HTTP call, the status and the body as text (the error body when it failed). Blocking: callers run it on IO. */
internal fun http(
    url: String,
    timeoutMillis: Int,
    headers: Map<String, String> = emptyMap(),
    method: String = "GET",
    body: String? = null,
): Pair<Int, String> {
    val c = URI(url).toURL().openConnection() as HttpURLConnection
    try {
        c.requestMethod = method
        c.connectTimeout = timeoutMillis
        c.readTimeout = timeoutMillis
        headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
        if (body != null) {
            c.doOutput = true
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        val status = c.responseCode
        val text = (if (status in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        return status to text
    } finally {
        c.disconnect()
    }
}

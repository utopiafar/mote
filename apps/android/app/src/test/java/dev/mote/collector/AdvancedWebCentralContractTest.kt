package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** The dedicated generated Central runner requires this case to execute. */
class AdvancedWebCentralContractTest {
    @Test fun actualCentralTicketsBecomeTheExactWebRecordingAndPreparationTargets() {
        val origin=System.getenv("MOTE_ADVANCED_ORIGIN").orEmpty();assumeTrue("Use advanced-web.ts",origin.isNotBlank())
        assertEquals("127.0.0.1",URL(origin).host)
        fun env(key:String)=requireNotNull(System.getenv(key))
        val token=env("MOTE_ADVANCED_SESSION");val collector=env("MOTE_ADVANCED_COLLECTOR");val revoked=env("MOTE_ADVANCED_REVOKED");val id=env("MOTE_ADVANCED_FILE");val output=File(env("MOTE_ADVANCED_OUTPUT"))
        fun client(credential:String)=CentralClient(origin,credential,{method,url,body,auth,mime->
            val connection=URL(url).openConnection() as HttpURLConnection
            try{connection.requestMethod=method;connection.instanceFollowRedirects=false;connection.connectTimeout=5000;connection.readTimeout=15000;connection.setRequestProperty("Authorization","Bearer $auth");connection.setRequestProperty("Content-Type",mime)
                if(body!=null){connection.doOutput=true;connection.outputStream.use{it.write(body)}}
                val status=connection.responseCode;val text=(if(status<400)connection.inputStream else connection.errorStream)?.bufferedReader()?.use{it.readText()};status to text?.takeIf{it.isNotBlank()}?.let(::JSONObject)
            }finally{connection.disconnect()}
        })
        val api=client(token);val scope=AdvancedWebAccess(origin,1,true);val urls=JSONArray()
        val targets=AdvancedWebTarget.RecordingTool.entries.map { AdvancedWebTarget.Recording(id,it) }+AdvancedWebTarget.Preparation.entries.map { AdvancedWebTarget.Models(it) }
        for(target in targets){val result=AdvancedWebNavigation.prepare(target,scope,{scope},{true}) { api.post("/api/login/ticket",JSONObject()) } as AdvancedWebResult.Ready
            result.launch({scope},{true}) { url->assertFalse(url.contains(token));urls.put(JSONObject().put("target",target.hash()).put("url",url)) }
        }
        val public=AdvancedWebNavigation.prepare(targets[0],scope,{scope},{true}) { client(collector).post("/api/login/ticket",JSONObject()) } as AdvancedWebResult.Ready
        assertFalse(public.url.contains("loginTicket"));assertFalse(public.url.contains(collector))
        val withdrawn=AdvancedWebNavigation.prepare(targets[0],scope,{scope},{true}) { client(revoked).post("/api/login/ticket",JSONObject()) } as AdvancedWebResult.Ready
        val expired=AdvancedWebNavigation.prepare(targets[1],scope,{scope},{true}) { api.post("/api/login/ticket",JSONObject().put("expiresAt",1)) } as AdvancedWebResult.Ready
        output.writeText(JSONObject().put("targets",urls).put("public",public.url).put("revoked",withdrawn.url).put("expired",expired.url).toString())
        assertEquals(6,urls.length())
    }
}

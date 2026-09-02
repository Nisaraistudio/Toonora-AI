import { NextRequest, NextResponse } from "next/server";
import admin from "firebase-admin";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { OpenAI } from "openai";

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// Create a sliding-window rate limiter via Upstash Redis (Serverless-friendly)
const ratelimiter = new Ratelimit({
  redis: Redis.fromEnv(), // Expects UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env
  limiter: Ratelimit.slidingWindow(20, "1 m"), // Max 20 generations per minute per user
  analytics: true,
  prefix: "@toonora/ratelimit",
});

export async function POST(request: NextRequest) {
  try {
    // 1. Authentication
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    // 2. Rate Limiting
    const { success, limit, reset, remaining } = await ratelimiter.limit(`${userId}:gen`);
    const rateLimitHeaders = {
      "X-RateLimit-Limit": limit.toString(),
      "X-RateLimit-Remaining": remaining.toString(),
      "X-RateLimit-Reset": reset.toString(),
    };
    if (!success) {
      return NextResponse.json(
        { error: "Quota exceeded" },
        { status: 429, headers: rateLimitHeaders }
      );
    }

    // 3. Payload Validation with Sanitization
    const body = await request.json();
    const { projectId, prompt } = body;
    
    if (typeof projectId !== 'string' || typeof prompt !== 'string') {
      return NextResponse.json({ error: "Invalid input types" }, { status: 400 });
    }
    if (projectId.length > 128 || prompt.length > 5000) {
      return NextResponse.json({ error: "Input exceeds limits" }, { status: 400 });
    }
    if (prompt.trim().length === 0) {
      return NextResponse.json({ error: "Prompt cannot be empty" }, { status: 400 });
    }

    // 4. Verify Project Ownership (SHORT transaction, outside AI call)
    const projectRef = db.collection("projects").doc(projectId);
    
    await db.runTransaction(async (transaction) => {
      const projectDoc = await transaction.get(projectRef);
      
      if (!projectDoc.exists) {
        throw new Error("NOT_FOUND");
      }
      if (projectDoc.data()?.userId !== userId) {
        throw new Error("FORBIDDEN");
      }
      
      return true; // Project verified as owned
    });

    // 5. AI Generation (OUTSIDE transaction - can take time)
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let generatedContent: string;
    
    try {
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are Toonora AI's creative assistant. Transform concepts into rich stories, scenes, and visual directions." },
          { role: "user", content: prompt }
        ],
        max_tokens: 2000,
      });
      generatedContent = aiResponse.choices[0]?.message?.content?.trim() || "";
      
      if (!generatedContent) {
        throw new Error("Empty generation");
      }
    } catch (aiError: any) {
      console.error("OpenAI error:", aiError.message);
      throw new Error(`AI_SERVICE_ERROR: ${aiError.status || 'unknown'}`);
    }

    // 6. Persist Generation & Audit Log (SECOND short transaction)
    const generationRef = projectRef.collection("generations").doc();
    const auditRef = db.collection("auditLogs").doc();

    await db.runTransaction(async (transaction) => {
      // Re-verify ownership hasn't changed (idempotent safety)
      const projectDoc = await transaction.get(projectRef);
      if (!projectDoc.exists || projectDoc.data()?.userId !== userId) {
        throw new Error("FORBIDDEN");
      }

      transaction.set(generationRef, {
        id: generationRef.id,
        prompt,
        result: generatedContent,
        provider: "openai",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.set(auditRef, {
        userId,
        projectId,
        action: "STORY_GENERATION",
        generationId: generationRef.id,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json(
      { success: true, data: generatedContent },
      { status: 200, headers: rateLimitHeaders }
    );

  } catch (error: any) {
    console.error("API Error:", error.message);
    
    if (error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error.message === "NOT_FOUND") {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (error.message?.startsWith("AI_SERVICE_ERROR")) {
      return NextResponse.json({ error: "AI service unavailable" }, { status: 503 });
    }
    
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

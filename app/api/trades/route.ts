import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { validateRequest } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { symbolId, amount, direction, entryPrice, duration } =
      await request.json();

    // Validate inputs
    if (!symbolId || !amount || !direction || !duration) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    // Fetch symbol and validate trade parameters
    const symbol = await prisma.symbol.findUnique({
      where: { id: symbolId },
    });

    if (!symbol) {
      return NextResponse.json({ error: "Symbol not found" }, { status: 404 });
    }

    if (!symbol.enabled) {
      return NextResponse.json(
        { error: "Trading is disabled for this symbol" },
        { status: 400 }
      );
    }

    if (amount < symbol.minAmount || amount > symbol.maxAmount) {
      return NextResponse.json(
        { error: "Invalid trade amount" },
        { status: 400 }
      );
    }

    // Check user's balance
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { balance: true },
    });

    if (!dbUser || dbUser.balance < amount) {
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 400 }
      );
    }

    // Create order and update balance in a transaction
    const expiresAt = new Date(Date.now() + duration * 1000);

    const [order] = await prisma.$transaction([
      // Create the order
      prisma.order.create({
        data: {
          userId: user.id,
          symbolId,
          amount,
          direction,
          entryPrice,
          manipulatedEntryPrice: entryPrice,
          duration,
          expiresAt,
          payout: symbol.payout,
        },
      }),
      // Update user's balance
      prisma.user.update({
        where: { id: user.id },
        data: {
          balance: {
            decrement: amount,
          },
        },
      }),
    ]);

    // Schedule trade resolution using WebSocket
    setTimeout(async () => {
      try {
        const ws = new WebSocket(
          `wss://stream.binance.com:9443/ws/${symbol.binanceSymbol.toLowerCase()}@ticker`
        );

        ws.onmessage = async (event) => {
          const data = JSON.parse(event.data);
          const exitPrice = parseFloat(data.c); // Live exit price

          const isWin =
            direction === "up"
              ? exitPrice > entryPrice
              : exitPrice < entryPrice;

          const profitLoss = isWin ? amount * (symbol.payout / 100) : -amount;

          await prisma.$transaction([
            // Update order
            prisma.order.update({
              where: { id: order.id },
              data: {
                exitPrice,
                manipulatedExitPrice: exitPrice,
                outcome: isWin ? "win" : "loss",
                profitLoss,
              },
            }),
            // Update user balance if won
            isWin
              ? prisma.user.update({
                  where: { id: user.id },
                  data: {
                    balance: {
                      increment: amount + profitLoss,
                    },
                  },
                })
              : prisma.user.update({ where: { id: user.id }, data: {} }),
          ]);

          ws.close();
        };

        ws.onerror = (error) => {
          console.error("WebSocket error:", error);
          ws.close();
        };
      } catch (error) {
        console.error("Error resolving trade:", error);
      }
    }, duration * 1000);

    return NextResponse.json({ success: true, order });
  } catch (error) {
    console.error("Error placing trade:", error);
    return NextResponse.json(
      { error: "Failed to place trade" },
      { status: 500 }
    );
  }
}

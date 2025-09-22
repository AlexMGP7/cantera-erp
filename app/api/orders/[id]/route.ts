// app/api/orders/[id]/route.ts
import { NextResponse } from "next/server";
import { executeQuery, TYPES } from "@/lib/db";
import { revalidateTag } from "next/cache";
import { orderUpdateSchema } from "@/lib/validations";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const id = Number.parseInt(params.id, 10);
    if (isNaN(id)) {
      return new NextResponse("ID de pedido inválido", { status: 400 });
    }

    const orderQuery = `
      SELECT
          p.id, p.order_number, p.status, p.created_at, p.notes,
          p.customer_id, p.destination_id,
          p.invoice_series, p.invoice_number, p.invoice_n, -- Se seleccionan los campos correctos
          c.name AS client_name, c.rfc,
          d.name AS destino_name,
          f.NUMSERIE AS serie, f.NUMFACTURA AS folio -- Se seleccionan los campos de la factura
      FROM RIP.APP_PEDIDOS p
      JOIN RIP.VW_APP_CLIENTES c ON c.id = p.customer_id
      LEFT JOIN RIP.APP_DESTINOS d ON d.id = p.destination_id
      -- Se hace JOIN a la tabla y con las columnas correctas
      LEFT JOIN dbo.FACTURASVENTA f ON p.invoice_series = f.NUMSERIE 
                                   AND p.invoice_number = f.NUMFACTURA 
                                   AND p.invoice_n = f.N
      WHERE p.id = @id;
    `;
    const orderResult = await executeQuery(orderQuery, [
      { name: "id", type: TYPES.Int, value: id },
    ]);

    if (orderResult.length === 0) {
      return new NextResponse("Pedido no encontrado", { status: 404 });
    }
    const order = orderResult[0];

    // ... (las consultas para items, trucks y drivers no cambian)
    // 2. Obtener los items del pedido
    const itemsQuery = `
   SELECT
     i.id, i.quantity, i.price_per_unit, i.unit,
     prod.id as product_id,
     prod.name AS product_name,
     prod.unit as product_unit
   FROM RIP.APP_PEDIDOS_ITEMS i
   JOIN RIP.VW_APP_PRODUCTOS prod ON prod.id = i.product_id
   WHERE i.order_id = @id;
  `;
    const itemsResult = await executeQuery(itemsQuery, [
      { name: "id", type: TYPES.Int, value: id },
    ]); // 3. Obtener los camiones autorizados

    const trucksQuery = `
   SELECT t.id, t.placa, t.brand, t.model
   FROM RIP.APP_PEDIDOS_CAMIONES pc
   JOIN RIP.APP_CAMIONES t ON t.id = pc.camion_id
   WHERE pc.pedido_id = @id;
  `;
    const trucksResult = await executeQuery(trucksQuery, [
      { name: "id", type: TYPES.Int, value: id },
    ]); // 4. Obtener los choferes autorizados

    const driversQuery = `
   SELECT c.id, c.name, c.docId
   FROM RIP.APP_PEDIDOS_CHOFERES pch
   JOIN RIP.APP_CHOFERES c ON c.id = pch.chofer_id
   WHERE pch.pedido_id = @id;
  `;
    const driversResult = await executeQuery(driversQuery, [
      { name: "id", type: TYPES.Int, value: id },
    ]);

    // --- 👇 CORRECCIÓN: Construcción del objeto de respuesta final ---
    const populatedOrder = {
      ...order,
      client: {
        id: order.customer_id,
        name: order.client_name,
        rfc: order.rfc,
      },
      // Se comprueba la existencia de los campos de la factura
      invoice:
        order.invoice_series && order.invoice_number
          ? {
              // Se usan los campos correctos que vienen de la consulta
              serie: order.invoice_series,
              folio: order.invoice_number,
              n: order.invoice_n,
            }
          : null,
      items: itemsResult.map((item: any) => ({
        id: item.id,
        quantity: Number(item.quantity),
        price_per_unit: Number(item.price_per_unit),
        unit: item.unit,
        product: {
          id: item.product_id,
          name: item.product_name,
          unit: item.product_unit,
        },
      })),
      trucks: trucksResult,
      drivers: driversResult,
    };

    return NextResponse.json(populatedOrder);
  } catch (error) {
    console.error(`[API_ORDERS_ID_GET]`, error);
    return new NextResponse("Error interno del servidor", { status: 500 });
  }
}

/**
 * @route   PUT /api/orders/[id]
 * @desc    Actualizar un pedido completo (datos, items, camiones y choferes)
 */
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const id = Number.parseInt(params.id, 10);
    if (isNaN(id)) {
      return new NextResponse("ID de pedido inválido", { status: 400 });
    }

    const body = await request.json();
    const validation = orderUpdateSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(validation.error.errors, { status: 400 });
    }

    const { items, truck_ids, driver_ids, ...orderData } = validation.data;

    const updateOrderQuery = `
        UPDATE RIP.APP_PEDIDOS
        SET customer_id = @customer_id, 
            destination_id = @destination_id, 
            total = @total, 
            invoice_series = @invoice_series,
            invoice_number = @invoice_number,
            invoice_n = @invoice_n,
            updated_at = GETDATE()
        WHERE id = @id;
    `;
    await executeQuery(updateOrderQuery, [
      { name: "id", type: TYPES.Int, value: id },
      { name: "customer_id", type: TYPES.Int, value: orderData.customer_id },
      {
        name: "destination_id",
        type: TYPES.Int,
        value: orderData.destination_id,
      },
      { name: "total", type: TYPES.Decimal, value: orderData.total },
      {
        name: "invoice_series",
        type: TYPES.NVarChar,
        value: orderData.invoice_series,
      },
      {
        name: "invoice_number",
        type: TYPES.Int,
        value: orderData.invoice_number,
      },
      { name: "invoice_n", type: TYPES.Int, value: orderData.invoice_n },
    ]);

    await executeQuery(
      `DELETE FROM RIP.APP_PEDIDOS_ITEMS WHERE order_id = @id`,
      [{ name: "id", type: TYPES.Int, value: id }]
    );

    for (const item of items) {
      const insertItemQuery = `
            INSERT INTO RIP.APP_PEDIDOS_ITEMS (order_id, product_id, quantity, price_per_unit, unit)
            VALUES (@order_id, @product_id, @quantity, @price_per_unit, @unit);
        `;
      await executeQuery(insertItemQuery, [
        { name: "order_id", type: TYPES.Int, value: id },
        { name: "product_id", type: TYPES.Int, value: item.product_id },
        { name: "quantity", type: TYPES.Decimal, value: item.quantity },
        {
          name: "price_per_unit",
          type: TYPES.Decimal,
          value: item.price_per_unit,
        },
        { name: "unit", type: TYPES.NVarChar, value: item.unit },
      ]);
    }

    // 3. Actualizar Camiones
    await executeQuery(
      `DELETE FROM RIP.APP_PEDIDOS_CAMIONES WHERE pedido_id = @id`,
      [{ name: "id", type: TYPES.Int, value: id }]
    );
    for (const truckId of truck_ids) {
      const insertTruckQuery = `INSERT INTO RIP.APP_PEDIDOS_CAMIONES (pedido_id, camion_id) VALUES (@pedido_id, @camion_id);`;
      await executeQuery(insertTruckQuery, [
        { name: "pedido_id", type: TYPES.Int, value: id },
        { name: "camion_id", type: TYPES.Int, value: truckId },
      ]);
    }

    // 4. Actualizar Choferes
    await executeQuery(
      `DELETE FROM RIP.APP_PEDIDOS_CHOFERES WHERE pedido_id = @id`,
      [{ name: "id", type: TYPES.Int, value: id }]
    );
    for (const driverId of driver_ids) {
      const insertDriverQuery = `INSERT INTO RIP.APP_PEDIDOS_CHOFERES (pedido_id, chofer_id) VALUES (@pedido_id, @chofer_id);`;
      await executeQuery(insertDriverQuery, [
        { name: "pedido_id", type: TYPES.Int, value: id },
        { name: "chofer_id", type: TYPES.Int, value: driverId },
      ]);
    }

    revalidateTag("orders");
    revalidateTag(`order-${id}`);

    return NextResponse.json({
      message: "Pedido actualizado correctamente",
      id: id,
    });
  } catch (error) {
    console.error(`[API_ORDERS_ID_PUT]`, error);
    return new NextResponse("Error interno del servidor", { status: 500 });
  }
}

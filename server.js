const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Servir las carpetas estáticas de las interfaces
app.use('/cliente', express.static(path.join(__dirname, 'AppCliente')));
app.use('/cadete', express.static(path.join(__dirname, 'AppDriver')));
app.use('/empresa', express.static(path.join(__dirname, 'AppEmpresa')));
app.use('/admin', express.static(path.join(__dirname, 'AppPaneldecontrol')));

// Base de datos en memoria del servidor (para arrancar las pruebas en la nube)
let baseDatosMemoria = {
    usuarios: [],
    empresas: [],
    cadetes: [],
    pedidos: []
};

// Ruta principal redirige directo al módulo cliente
app.get('/', (req, res) => {
    res.redirect('/cliente');
});

// 1. GESTIÓN DE EMPRESAS Y CATÁLOGOS
app.get('/api/empresas', (req, res) => {
    res.json(baseDatosMemoria.empresas);
});

app.post('/api/empresas', (req, res) => {
    const nuevaEmpresa = req.body;
    baseDatosMemoria.empresas.push(nuevaEmpresa);
    res.json({ exito: true, mensaje: 'Empresa registrada con éxito', empresa: nuevaEmpresa });
});

// 2. GESTIÓN DE PEDIDOS
app.get('/api/pedidos', (req, res) => {
    res.json(baseDatosMemoria.pedidos);
});

app.post('/api/pedidos', (req, res) => {
    const nuevoPedido = req.body;
    baseDatosMemoria.pedidos.push(nuevoPedido);
    res.json({ exito: true, mensaje: 'Pedido creado y sincronizado', pedido: nuevoPedido });
});

app.put('/api/pedidos/:id', (req, res) => {
    const idPedido = Number(req.params.id);
    const { estado } = req.body;
    
    let pedido = baseDatosMemoria.pedidos.find(p => Number(p.id) === idPedido);
    if (pedido) {
        pedido.estado = estado;
        res.json({ exito: true, mensaje: 'Estado del pedido actualizado', pedido });
    } else {
        res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado' });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
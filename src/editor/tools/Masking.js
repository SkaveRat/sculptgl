define([
  'lib/glMatrix',
  'misc/Utils',
  'misc/Tablet',
  'editor/tools/SculptBase',
  'editor/tools/Paint',
  'editor/tools/Smooth',
  'mesh/Mesh'
], function (glm, Utils, Tablet, SculptBase, Paint, Smooth, Mesh) {

  'use strict';

  var vec3 = glm.vec3;
  var mat3 = glm.mat3;

  var Masking = function (states) {
    SculptBase.call(this, states);
    this.hardness_ = 0.25;
    this.intensity_ = 1.0; // deformation intensity
    this.negative_ = true; // opposition deformation
    this.culling_ = false; // if we backface cull the vertices
    this.idAlpha_ = 0;
    this.lockPosition_ = false;

    this.thickness_ = 1.0;
  };

  Masking.prototype = {
    pushState: function () {
      // too lazy to add a pushStateMaterial
      this.states_.pushStateColorAndMaterial(this.mesh_);
    },
    updateMeshBuffers: function () {
      if (this.mesh_.getDynamicTopology)
        this.mesh_.updateBuffers();
      else
        this.mesh_.updateMaterialBuffer();
    },
    stroke: function (picking) {
      Paint.prototype.stroke.call(this, picking);
    },
    /** Paint color vertices */
    paint: function (iVerts, center, radiusSquared, intensity, hardness, picking) {
      var mesh = this.mesh_;
      var vAr = mesh.getVertices();
      var mAr = mesh.getMaterials();
      var radius = Math.sqrt(radiusSquared);
      var cx = center[0];
      var cy = center[1];
      var cz = center[2];
      var softness = 2 * (1 - hardness);
      var maskIntensity = this.negative_ ? -intensity : intensity;
      for (var i = 0, l = iVerts.length; i < l; ++i) {
        var ind = iVerts[i] * 3;
        var vx = vAr[ind];
        var vy = vAr[ind + 1];
        var vz = vAr[ind + 2];
        var dx = vx - cx;
        var dy = vy - cy;
        var dz = vz - cz;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius;
        var fallOff = Math.pow(1 - dist, softness);
        fallOff *= maskIntensity * picking.getAlpha(vx, vy, vz);
        mAr[ind + 2] = Math.min(Math.max(mAr[ind + 2] + fallOff, 0.0), 1.0);
      }
    },
    updateAndRenderMask: function (main) {
      this.mesh_.updateDuplicateColorsAndMaterials();
      this.mesh_.updateFlatShading();
      this.updateRender(main);
    },
    blur: function (mesh, main) {
      this.mesh_ = mesh;
      var iVerts = this.getMaskedVertices();
      if (iVerts.length === 0) return;
      iVerts = mesh.expandsVertices(iVerts, 1);

      this.pushState();
      this.states_.pushVertices(iVerts);

      var mAr = mesh.getMaterials();
      var nbVerts = iVerts.length;
      var smoothVerts = new Float32Array(nbVerts * 3);
      this.laplacianSmooth(iVerts, smoothVerts, mAr);
      for (var i = 0; i < nbVerts; ++i)
        mAr[iVerts[i] * 3 + 2] = smoothVerts[i * 3 + 2];
      this.updateAndRenderMask(main);
    },
    sharpen: function (mesh, main) {
      this.mesh_ = mesh;
      var iVerts = this.getMaskedVertices();
      if (iVerts.length === 0) return;

      this.pushState();
      this.states_.pushVertices(iVerts);

      var mAr = mesh.getMaterials();
      var nbVerts = iVerts.length;
      for (var i = 0; i < nbVerts; ++i) {
        var idm = iVerts[i] * 3 + 2;
        var val = mAr[idm];
        mAr[idm] = val > 0.5 ? Math.min(val + 0.1, 1.0) : Math.max(val - 1.0, 0.0);
      }
      this.updateAndRenderMask(main);
    },
    clear: function (mesh, main) {
      this.mesh_ = mesh;
      var iVerts = this.getMaskedVertices();
      if (iVerts.length === 0) return;

      this.pushState();
      this.states_.pushVertices(iVerts);

      var mAr = mesh.getMaterials();
      for (var i = 0, nb = iVerts.length; i < nb; ++i)
        mAr[iVerts[i] * 3 + 2] = 1.0;

      this.updateAndRenderMask(main);
    },
    invert: function (mesh, main, isState) {
      this.mesh_ = mesh;
      if (!isState)
        this.states_.pushStateCustom(this.invert.bind(this, mesh, main, true));

      var mAr = mesh.getMaterials();
      for (var i = 0, nb = mesh.getNbVertices(); i < nb; ++i)
        mAr[i * 3 + 2] = 1.0 - mAr[i * 3 + 2];

      this.updateAndRenderMask(main);
    },
    remapAndMirrorIndices: function (fAr, nbFaces, iVerts) {
      var nbVertices = this.mesh_.getNbVertices();
      var iTag = new Uint32Array(Utils.getMemory(nbVertices * 4), 0, nbVertices);
      var i = 0;
      var j = 0;
      var nbVerts = iVerts.length;
      for (i = 0; i < nbVerts; ++i)
        iTag[iVerts[i]] = i;

      var endFaces = nbFaces * 2;
      for (i = 0; i < endFaces; ++i) {
        j = i * 4;
        var offset = i < nbFaces ? 0 : nbVerts;
        fAr[j] = iTag[fAr[j]] + offset;
        fAr[j + 1] = iTag[fAr[j + 1]] + offset;
        fAr[j + 2] = iTag[fAr[j + 2]] + offset;
        var id4 = fAr[j + 3];
        if (id4 >= 0) fAr[j + 3] = iTag[id4] + offset;
      }
      var end = fAr.length / 4;
      for (i = endFaces; i < end; ++i) {
        j = i * 4;
        fAr[j] = iTag[fAr[j]];
        fAr[j + 1] = iTag[fAr[j + 1]];
        fAr[j + 2] = iTag[fAr[j + 2]] + nbVerts;
        fAr[j + 3] = iTag[fAr[j + 3]] + nbVerts;
      }
    },
    invertFaces: function (fAr) {
      for (var i = 0, nb = fAr.length; i < nb; ++i) {
        var id = i * 4;
        var temp = fAr[id];
        fAr[id] = fAr[id + 2];
        fAr[id + 2] = temp;
      }
    },
    extractFaces: function (iFaces, iVerts, maskClamp) {
      var mesh = this.mesh_;
      var fAr = mesh.getFaces();
      var mAr = mesh.getMaterials();
      var eAr = mesh.getVerticesOnEdge();

      var nbFaces = iFaces.length;
      var nbNewFaces = new Int32Array(Utils.getMemory(nbFaces * 4 * 4 * 3), 0, nbFaces * 4 * 3);
      var offsetFLink = nbFaces * 2;
      for (var i = 0; i < nbFaces; ++i) {
        var idf = i * 4;
        var idOld = iFaces[i] * 4;
        var iv1 = nbNewFaces[idf] = fAr[idOld];
        var iv2 = nbNewFaces[idf + 1] = fAr[idOld + 1];
        var iv3 = nbNewFaces[idf + 2] = fAr[idOld + 2];
        var iv4 = nbNewFaces[idf + 3] = fAr[idOld + 3];
        var isQuad = iv4 >= 0;

        var b1 = mAr[iv1 * 3 + 2] >= maskClamp || eAr[iv1] >= 1;
        var b2 = mAr[iv2 * 3 + 2] >= maskClamp || eAr[iv2] >= 1;
        var b3 = mAr[iv3 * 3 + 2] >= maskClamp || eAr[iv3] >= 1;
        var b4 = isQuad ? mAr[iv4 * 3 + 2] >= maskClamp || eAr[iv4] >= 1 : false;

        // create opposite face (layer), invert clockwise
        // quad =>
        // 1 2    3 2
        // 4 3    4 1
        // tri => 
        // 1 2    3 2
        //  3      1

        idf += nbFaces * 4;
        nbNewFaces[idf] = iv3;
        nbNewFaces[idf + 1] = iv2;
        nbNewFaces[idf + 2] = iv1;
        nbNewFaces[idf + 3] = iv4;

        // create bridges faces
        if (b2) {
          if (b1) {
            idf = 4 * (offsetFLink++);
            nbNewFaces[idf] = nbNewFaces[idf + 3] = iv2;
            nbNewFaces[idf + 1] = nbNewFaces[idf + 2] = iv1;
          }
          if (b3) {
            idf = 4 * (offsetFLink++);
            nbNewFaces[idf] = nbNewFaces[idf + 3] = iv3;
            nbNewFaces[idf + 1] = nbNewFaces[idf + 2] = iv2;
          }
        }
        if (isQuad) {
          if (b4) {
            if (b1) {
              idf = 4 * (offsetFLink++);
              nbNewFaces[idf] = nbNewFaces[idf + 3] = iv1;
              nbNewFaces[idf + 1] = nbNewFaces[idf + 2] = iv4;
            }
            if (b3) {
              idf = 4 * (offsetFLink++);
              nbNewFaces[idf] = nbNewFaces[idf + 3] = iv4;
              nbNewFaces[idf + 1] = nbNewFaces[idf + 2] = iv3;
            }
          }
        } else {
          if (b1 && b3) {
            idf = 4 * (offsetFLink++);
            nbNewFaces[idf] = nbNewFaces[idf + 3] = iv1;
            nbNewFaces[idf + 1] = nbNewFaces[idf + 2] = iv3;
          }
        }
      }

      var fArNew = new Int32Array(nbNewFaces.subarray(0, offsetFLink * 4));
      this.remapAndMirrorIndices(fArNew, nbFaces, iVerts);
      if (this.thickness_ > 0)
        this.invertFaces(fArNew);
      return fArNew;
    },
    extractVertices: function (iVerts) {
      var mesh = this.mesh_;

      var vAr = mesh.getVertices();
      var nAr = mesh.getNormals();
      var mat = mesh.getMatrix();
      var nMat = mat3.normalFromMat4(mat3.create(), mat);
      var nbVerts = iVerts.length;
      var vArNew = new Float32Array(nbVerts * 2 * 3);
      var vTemp = [0.0, 0.0, 0.0];
      var nTemp = [0.0, 0.0, 0.0];
      var vOffset = nbVerts * 3;
      var thick = this.thickness_;
      var eps = 0.01;
      if (thick < 0) eps = -eps;
      for (var i = 0; i < nbVerts; ++i) {
        var idv = i * 3;
        var idvOld = iVerts[i] * 3;
        vTemp[0] = vAr[idvOld];
        vTemp[1] = vAr[idvOld + 1];
        vTemp[2] = vAr[idvOld + 2];
        nTemp[0] = nAr[idvOld];
        nTemp[1] = nAr[idvOld + 1];
        nTemp[2] = nAr[idvOld + 2];
        vec3.transformMat3(nTemp, nTemp, nMat);
        vec3.normalize(nTemp, nTemp);

        vec3.transformMat4(vTemp, vTemp, mat);
        vec3.scaleAndAdd(vTemp, vTemp, nTemp, eps);
        vArNew[idv] = vTemp[0];
        vArNew[idv + 1] = vTemp[1];
        vArNew[idv + 2] = vTemp[2];

        vec3.scaleAndAdd(vTemp, vTemp, nTemp, thick);
        idv += vOffset;
        vArNew[idv] = vTemp[0];
        vArNew[idv + 1] = vTemp[1];
        vArNew[idv + 2] = vTemp[2];
      }
      return vArNew;
    },
    smoothBorder: function (mesh, iFaces) {
      var smo = new Smooth();
      smo.mesh_ = mesh;
      var startBridge = iFaces.length * 2;
      var fBridge = new Uint32Array(mesh.getNbFaces() - startBridge);
      for (var i = 0, nbBridge = fBridge.length; i < nbBridge; ++i)
        fBridge[i] = startBridge + i;
      var vBridge = mesh.expandsVertices(mesh.getVerticesFromFaces(fBridge), 1);
      smo.smooth(vBridge, 1.0);
      smo.smooth(vBridge, 1.0);
      smo.smooth(vBridge, 1.0);
    },
    extract: function (mesh, main) {
      this.mesh_ = mesh;
      var maskClamp = 0.5;

      var iVerts = this.filterMaskedVertices(-Infinity, maskClamp);
      if (iVerts.length === 0) return;
      var iFaces = mesh.getFacesFromVertices(iVerts);
      iVerts = mesh.getVerticesFromFaces(iFaces);

      var fArNew = this.extractFaces(iFaces, iVerts, maskClamp);
      var vArNew = this.extractVertices(iVerts);

      var newMesh = new Mesh(mesh.getGL());
      newMesh.setVertices(vArNew);
      newMesh.setFaces(fArNew);

      // we don't use newMesh.init because we want to smooth
      // the border (we want to avoid an update octree/normal/etc...)
      newMesh.initColorsAndMaterials();
      newMesh.allocateArrays();
      newMesh.initTopology();
      this.smoothBorder(newMesh, iFaces);
      newMesh.updateGeometry();
      newMesh.updateDuplicateColorsAndMaterials();

      newMesh.copyRenderConfig(mesh);
      newMesh.initRender();
      main.addNewMesh(newMesh);
      main.setMesh(mesh);
    }
  };

  Utils.makeProxy(SculptBase, Masking);

  return Masking;
});
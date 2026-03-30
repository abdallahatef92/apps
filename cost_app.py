import streamlit as st
import pandas as pd
import numpy as np
import pytesseract
from PIL import Image
import cv2

# =========================
# CONFIG
# =========================
st.set_page_config(layout="wide")
st.title("📊 Cost Control Manager - Image Analysis Tool")

# 👉 SET YOUR TESSERACT PATH (IMPORTANT)
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

# =========================
# OCR FUNCTION
# =========================
def extract_table_from_image(image):
    img = np.array(image)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    # Improve contrast
    thresh = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)[1]

    custom_config = r'--oem 3 --psm 6'
    text = pytesseract.image_to_string(thresh, config=custom_config)

    lines = text.split("\n")
    data = []

    for line in lines:
        line = line.strip()

        if not line:
            continue

        if "CSI" in line or "BAC" in line:
            continue

        parts = line.split()

        if len(parts) >= 6:
            try:
                bac = float(parts[-3].replace(",", ""))
                ac = float(parts[-2].replace(",", ""))
                ev = float(parts[-1].replace(",", ""))

                csi = parts[0]
                package = parts[1]
                description = " ".join(parts[2:-3])

                data.append([csi, package, description, bac, ac, ev])
            except:
                continue

    df = pd.DataFrame(data, columns=["CSI", "Package", "Description", "BAC", "AC", "EV"])
    return df

# =========================
# FILE UPLOAD
# =========================
st.header("📥 Upload Cost Reports (Images)")

col1, col2 = st.columns(2)

file_lm = col1.file_uploader("Upload Last Month Image", type=["png", "jpg", "jpeg"])
file_cm = col2.file_uploader("Upload Current Month Image", type=["png", "jpg", "jpeg"])

# =========================
# PROCESS
# =========================
if file_lm and file_cm:

    st.subheader("📸 Uploaded Images")

    col1.image(file_lm, caption="Last Month", use_container_width=True)
    col2.image(file_cm, caption="Current Month", use_container_width=True)

    # OCR extraction
    df_lm = extract_table_from_image(Image.open(file_lm))
    df_cm = extract_table_from_image(Image.open(file_cm))

    st.subheader("✏️ Validate Extracted Data")

    st.write("Last Month Data")
    df_lm = st.data_editor(df_lm, use_container_width=True)

    st.write("Current Month Data")
    df_cm = st.data_editor(df_cm, use_container_width=True)

    # Merge
    df = pd.merge(
        df_lm,
        df_cm,
        on=["CSI", "Package", "Description"],
        suffixes=("_LM", "_CM")
    )

    # =========================
    # ANALYSIS BUTTON
    # =========================
    if st.button("🚀 Run Cost Analysis"):

        # Calculations
        df["ΔAC"] = df["AC_CM"] - df["AC_LM"]
        df["ΔEV"] = df["EV_CM"] - df["EV_LM"]
        df["CV"] = df["EV_CM"] - df["AC_CM"]
        df["CPI"] = df["EV_CM"] / df["AC_CM"]

        # KPIs
        total_dac = df["ΔAC"].sum()
        total_cv = df["CV"].sum()
        avg_cpi = df["CPI"].mean()

        st.subheader("📊 KPI Overview")

        c1, c2, c3 = st.columns(3)
        c1.metric("Total ΔAC", f"{total_dac:,.0f}")
        c2.metric("Total CV", f"{total_cv:,.0f}")
        c3.metric("Average CPI", f"{avg_cpi:.2f}")

        # Table
        st.subheader("📋 Detailed Analysis")
        st.dataframe(df, use_container_width=True)

        # =========================
        # TOP CONCERNS
        # =========================
        st.subheader("⚠️ Top Concerns")

        top_cost = df.sort_values("ΔAC", ascending=False).head(3)
        worst_cpi = df.sort_values("CPI").head(3)
        worst_cv = df.sort_values("CV").head(3)

        st.write("🔴 Highest Cost Increase")
        st.dataframe(top_cost[["CSI", "Package", "ΔAC"]])

        st.write("🔴 Worst CPI")
        st.dataframe(worst_cpi[["CSI", "Package", "CPI"]])

        st.write("🔴 Worst CV")
        st.dataframe(worst_cv[["CSI", "Package", "CV"]])

        # =========================
        # SMART INSIGHTS
        # =========================
        st.subheader("🧠 Executive Summary")

        insights = []

        for _, row in df.iterrows():

            if row["CPI"] < 0.85:
                insights.append(
                    f"{row['Package']} (CSI {row['CSI']}) shows critical inefficiency (CPI={row['CPI']:.2f})"
                )

            elif row["ΔAC"] > 0 and row["ΔEV"] <= 0:
                insights.append(
                    f"{row['Package']} is consuming cost without progress"
                )

            elif row["CPI"] >= 1:
                insights.append(
                    f"{row['Package']} is performing efficiently"
                )

        summary = f"""
        Overall project performance shows average CPI of {avg_cpi:.2f}.
        Total cost change is {total_dac:,.0f}, while cost variance stands at {total_cv:,.0f}.

        Key observations:
        - {"; ".join(insights[:5])}
        """

        st.info(summary)

else:
    st.info("Please upload both images to start analysis.")
